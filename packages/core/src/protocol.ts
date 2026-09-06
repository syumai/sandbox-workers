import {
  ErrorCode,
  SandboxError,
  errorCodeForErrno,
  httpStatusForCode,
  type ErrorResponse,
  type OperationType,
} from "./errors.js";

export const MAX_REQUEST_BYTES = 96 * 1024;
/** Session file operations carry up to a 1 MiB file as base64, so they get a larger cap. */
export const MAX_FILES_REQUEST_BYTES = 2 * 1024 * 1024;
/**
 * `POST /interpreters/:key/execute`'s workspace sync payload carries up to
 * the full 16 MiB workspace as base64 (~21 MiB) plus its manifest, so it gets
 * a dedicated, larger cap than every other route (see
 * docs/sandbox-1-0-design.md, "Wire protocol: sandbox Durable Object ->
 * runtime Worker").
 */
export const MAX_SYNC_REQUEST_BYTES = 24 * 1024 * 1024;
export const MAX_CODE_BYTES = 64 * 1024;
const ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ExecutionRequest {
  code: string;
  envVars?: Record<string, string>;
}

export interface ExecutionLog {
  stdout: string[];
  stderr: string[];
}
export interface ExecutionUsage {
  fuelConsumed: number;
  fuelLimit: number;
  memoryBytes: number;
}
export interface ExecutionError {
  name: string;
  message: string;
  traceback: string[];
  lineNumber?: number;
}
/**
 * Shape of a context's embedded memory-snapshot record, as reported by an
 * interpreter Durable Object (see docs/snapshot-cost-design.md and
 * docs/sandbox-1-0-design.md's `Interpreter`). `pages`/`bytes` are the
 * snapshot's live (non-zero) data; `storedBytes` is its actual on-disk
 * footprint, which is larger because a chunk with any non-zero page is
 * stored whole.
 */
export interface SnapshotInfo {
  build: string;
  pages: number;
  bytes: number;
  storedBytes: number;
  takenAt: number;
  stale: boolean;
}
export interface ExecutionResult {
  code: string;
  logs: ExecutionLog;
  results: Array<{ text?: string; json?: JsonValue }>;
  error?: ExecutionError;
  executionCount?: number;
  // extensions
  language: string;
  engine: string;
  durationMs: number;
  usage?: ExecutionUsage;
  /**
   * Present when the execution ran inside a code context (absent for a
   * stateless run against a `contexts: false` binding). This is the
   * caller-facing `Sandbox` Durable Object's own context row -- it does not
   * carry the `Interpreter`'s `snapshot` record (see
   * `InterpreterExecuteResponse` below); that goes into `getInfo()` instead.
   */
  context?: {
    id: string;
    cwd: string;
    executions: number;
    snapshotMs?: number;
    expiresAt?: number;
  };
}

/**
 * The `workspace` field of `POST /interpreters/:key/execute`'s request body
 * (see docs/sandbox-1-0-design.md, "Workspace mirror and sync protocol").
 */
export interface InterpreterSyncRequest {
  /** Every directory under /workspace (absolute paths), full list. */
  dirs: string[];
  /** Every file: absolute path -> content hash (`Workspace.hashBytes`). */
  manifest: Record<string, string>;
  /** Contents the interpreter may not have yet. */
  files: Array<{ path: string; data: string; updatedAt: number }>;
}

/**
 * The `workspace` field of `POST /interpreters/:key/execute`'s response body.
 */
export interface InterpreterSyncResponse {
  /** Full directory list after the run. */
  dirs: string[];
  /** Files created or updated by the run. */
  files: Array<{ path: string; data: string; updatedAt: number }>;
  /** Files removed by the run. */
  deleted: string[];
}

/**
 * Body of `GET /interpreter`, served by every runtime Worker without a
 * Durable Object round trip (see docs/sandbox-1-0-design.md). `contexts` is
 * `false` for Ruby and for a Worker deployed without an `INTERPRETER`
 * binding (`--stateless`).
 */
export interface InterpreterInfo {
  language: string;
  engine: string;
  contexts: boolean;
}

/**
 * The runtime-side body of a successful (non-`resync`) `POST
 * /interpreters/:key/execute` response: `ExecutionResult`'s fields (minus
 * its caller-facing `context`) plus the interpreter's own `context` (which
 * carries `snapshot`, unlike `ExecutionResult.context`) and the `workspace`
 * diff. See docs/sandbox-1-0-design.md, "Workspace mirror and sync
 * protocol". Consumed by the `Sandbox` Durable Object (`sandbox.ts`), which
 * strips `workspace` and replaces `context`/`executionCount` with its own
 * registry's view before answering the caller.
 */
export interface InterpreterExecuteResponse extends Omit<ExecutionResult, "context"> {
  executionCount: number;
  context: {
    id: string;
    cwd: string;
    executions: number;
    snapshotMs?: number;
    snapshot: SnapshotInfo | null;
  };
  workspace: InterpreterSyncResponse;
}

export interface LanguageEngine {
  fetch(request: Request): Promise<Response>;
}

export async function readExecution(
  request: Request,
  options?: {
    /**
     * When given, a `language` key in the body is validated against this
     * runtime via `resolveLanguage` (aliases accepted) instead of being
     * unconditionally rejected. Used by the plain `/execute` route on every
     * runtime Worker.
     */
    runtimeLanguage?: string;
  },
): Promise<ExecutionRequest> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(415, "Content-Type must be application/json");
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES)
    throw new ApiError(413, "Request too large");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "Expected an object");
  const value = body as Record<string, unknown>;
  if ("input" in value)
    throw new ApiError(
      400,
      "input is no longer supported; pass data with envVars",
    );
  if ("language" in value) {
    if (options?.runtimeLanguage === undefined)
      throw new ApiError(
        400,
        "language is no longer supported; the runtime is selected by the Service Binding",
      );
    if (typeof value.language !== "string")
      throw new ApiError(400, "language must be a string");
    // Validates (and normalizes aliases); the resolved value isn't part of
    // ExecutionRequest -- execution always uses the runtime's own engine.
    resolveLanguage(value.language, options.runtimeLanguage);
  }
  if (typeof value.code !== "string" || !value.code.trim())
    throw new ApiError(400, "Non-empty code is required");
  if (new TextEncoder().encode(value.code).length > MAX_CODE_BYTES)
    throw new ApiError(413, "Code exceeds 64 KiB");
  let envVars: Record<string, string> | undefined;
  if (value.envVars !== undefined) {
    if (
      typeof value.envVars !== "object" ||
      value.envVars === null ||
      Array.isArray(value.envVars)
    )
      throw new ApiError(400, "envVars must be an object");
    envVars = {};
    for (const [key, raw] of Object.entries(
      value.envVars as Record<string, unknown>,
    )) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== "string")
        throw new ApiError(400, "envVars values must be strings");
      if (!ENV_VAR_KEY.test(key)) continue;
      envVars[key] = raw;
    }
  }
  return { code: value.code, ...(envVars ? { envVars } : {}) };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: ErrorCode = ErrorCode.VALIDATION_FAILED,
    public context: Record<string, unknown> = {},
    public operation?: OperationType,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Normalizes the SDK's language aliases, case-insensitively:
 * `python3`→`python`, `js`/`node`→`javascript`, `ts`→`typescript`. Anything
 * else is only lowercased (an unsupported language is still rejected by
 * `resolveLanguage` below, against the runtime's actual language).
 */
export function normalizeLanguage(requested: string): string {
  const lower = requested.toLowerCase();
  switch (lower) {
    case "python3":
      return "python";
    case "js":
    case "node":
      return "javascript";
    case "ts":
      return "typescript";
    default:
      return lower;
  }
}

/**
 * Resolves a requested language against a runtime's actual language: a
 * context/execution's language must be the runtime language (after alias
 * normalization), or "typescript" when the runtime is "javascript" (the JS
 * engine parses both dialects without a separate mode). Returns the
 * *normalized requested* language unchanged otherwise (so a "typescript"
 * request stays "typescript", distinct from a "javascript" one) — callers
 * that need the runtime's own language for execution/reporting use
 * `runtimeLanguage` directly. `requested` undefined returns `runtimeLanguage`.
 */
export function resolveLanguage(
  requested: string | undefined,
  runtimeLanguage: string,
): string {
  if (requested === undefined) return runtimeLanguage;
  const normalized = normalizeLanguage(requested);
  if (normalized === runtimeLanguage) return normalized;
  if (runtimeLanguage === "javascript" && normalized === "typescript")
    return normalized;
  throw new ApiError(
    400,
    `Unsupported language '${requested}' on this runtime (${runtimeLanguage})`,
  );
}
/**
 * Reads a request body up to `maxBytes`, without validating its shape. Used
 * by callers that forward a JSON body unchanged (the gateway's session
 * routes) rather than parsing an `ExecutionRequest` (see `readExecution`).
 */
export async function readBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new ApiError(413, "Request too large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

/** Emits `ErrorResponse` (see docs/sdk-parity-design.md, "Errors"). */
export function errorResponse(error: unknown): Response {
  let payload: ErrorResponse;
  if (error instanceof ApiError) {
    payload = {
      code: error.code,
      message: error.message,
      context: error.context,
      httpStatus: error.status,
      timestamp: new Date().toISOString(),
      ...(error.operation !== undefined ? { operation: error.operation } : {}),
    };
  } else if (error instanceof SandboxError) {
    payload = error.errorResponse;
  } else {
    payload = {
      code: ErrorCode.INTERNAL_ERROR,
      message: "Engine execution failed",
      context: {},
      httpStatus: 502,
      timestamp: new Date().toISOString(),
    };
  }
  return Response.json(payload, {
    status: payload.httpStatus,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Builds an `ErrorResponse` for a workspace errno (see
 * docs/sdk-parity-design.md, "Errors"). Used by the runtime Durable Object
 * to report filesystem failures without depending on `ApiError`/`SandboxError`.
 * `codeOverride`, when given, replaces the errno's usual `errorCodeForErrno`
 * mapping (used by `mkdir`, whose failures are always `FILESYSTEM_ERROR` per
 * the SDK, while `context.errno` still carries the Node-style code).
 */
export function errnoErrorResponse(
  errno: string,
  message: string,
  context: { path?: string; operation?: OperationType; [key: string]: unknown },
  codeOverride?: ErrorCode,
): Response {
  const code = codeOverride ?? errorCodeForErrno(errno);
  const httpStatus = httpStatusForCode(code);
  const payload: ErrorResponse = {
    code,
    message,
    context: { ...context, errno },
    httpStatus,
    timestamp: new Date().toISOString(),
    ...(context.operation !== undefined ? { operation: context.operation } : {}),
  };
  return Response.json(payload, {
    status: httpStatus,
    headers: { "cache-control": "no-store" },
  });
}
