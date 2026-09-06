import type { ExecutionError, ExecutionResult, JsonValue } from "./protocol.js";
import { ErrorCode, SandboxError, createErrorFromResponse } from "./errors.js";

export type SandboxLanguage =
  | "python"
  | "javascript"
  | "typescript"
  | "perl"
  | "ruby";

/**
 * Either a Service Binding (`Fetcher`-shaped) targeting the runtime Worker
 * directly, or a Durable Object namespace bound with `script_name` to it.
 * Declared structurally so this package doesn't depend on
 * `@cloudflare/workers-types` being installed.
 */
export type SandboxTarget =
  | { fetch(request: Request): Promise<Response> }
  | {
      idFromName(name: string): unknown;
      get(id: unknown): { fetch(request: Request): Promise<Response> };
    };

export interface SandboxOptions {
  /** Lowercase `id` before validating/using it. */
  normalizeId?: boolean;
}

export interface CreateContextOptions {
  language?: SandboxLanguage;
  cwd?: string;
  envVars?: Record<string, string | undefined>;
}
export interface CodeContext {
  readonly id: string;
  readonly language: string;
  readonly cwd: string;
  readonly createdAt: Date;
  readonly lastUsed: Date;
}

export interface OutputMessage {
  text: string;
  timestamp: number;
}
export interface Result {
  text?: string;
  json?: JsonValue;
  formats(): string[];
}

export interface RunCodeOptions {
  context?: CodeContext;
  language?: SandboxLanguage;
  envVars?: Record<string, string | undefined>;
  /** Request timeout; builds an `AbortSignal.timeout(timeout)`. The guest is still bounded by fuel. */
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (output: OutputMessage) => void | Promise<void>;
  onStderr?: (output: OutputMessage) => void | Promise<void>;
  onResult?: (result: Result) => void | Promise<void>;
  onError?: (error: ExecutionError) => void | Promise<void>;
}

export type FileEncoding = "utf-8" | "utf8" | "base64";
export interface WriteFileOptions {
  encoding?: FileEncoding;
}
export interface ReadFileOptions {
  encoding?: FileEncoding;
}
export interface WriteFileResult {
  success: boolean;
  path: string;
  timestamp: string;
}
export interface ReadFileResult {
  success: boolean;
  path: string;
  content: string;
  timestamp: string;
  encoding?: "utf-8" | "base64";
  isBinary?: boolean;
  mimeType?: string;
  size?: number;
}
export interface MkdirResult {
  success: boolean;
  path: string;
  recursive: boolean;
  timestamp: string;
}
export interface DeleteFileOptions {
  recursive?: boolean;
  force?: boolean;
}
export interface DeleteFileResult {
  success: boolean;
  path: string;
  timestamp: string;
}
export interface RenameFileResult {
  success: boolean;
  path: string;
  newPath: string;
  timestamp: string;
}
export interface MoveFileResult {
  success: boolean;
  path: string;
  newPath: string;
  timestamp: string;
}
export interface FileExistsResult {
  success: boolean;
  path: string;
  exists: boolean;
  timestamp: string;
}
export interface FileInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  mode: string;
  permissions: { readable: boolean; writable: boolean; executable: boolean };
}
export interface ListFilesOptions {
  recursive?: boolean;
  includeHidden?: boolean;
}
export interface ListFilesResult {
  success: boolean;
  path: string;
  files: FileInfo[];
  count: number;
  timestamp: string;
}

export interface SandboxInfo {
  id: string;
  language: string;
  engine: string;
  createdAt: string;
  lastUsed: string;
  envVars: Record<string, string>;
  contexts: Array<{
    id: string;
    language: string;
    cwd: string;
    createdAt: string;
    lastUsed: string;
    executions: number;
    snapshot: {
      build: string;
      pages: number;
      bytes: number;
      // Actual on-disk footprint (chunkCount * 1 MiB), larger than `bytes`
      // because a 1 MiB chunk containing any non-zero page is stored whole
      // (docs/snapshot-cost-design.md).
      storedBytes: number;
      takenAt: string;
      stale: boolean;
    } | null;
  }>;
  workspace: { files: number; bytes: number };
  expiresAt: number | null;
}

/** A container-backed sandbox: a code interpreter plus a shared `/workspace`. */
export interface Sandbox {
  readonly id: string;
  createCodeContext(options?: CreateContextOptions): Promise<CodeContext>;
  listCodeContexts(): Promise<CodeContext[]>;
  deleteCodeContext(id: string): Promise<void>;
  runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>;
  setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<WriteFileResult>;
  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>;
  mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<MkdirResult>;
  deleteFile(
    path: string,
    options?: DeleteFileOptions,
  ): Promise<DeleteFileResult>;
  renameFile(oldPath: string, newPath: string): Promise<RenameFileResult>;
  moveFile(
    sourcePath: string,
    destinationPath: string,
  ): Promise<MoveFileResult>;
  listFiles(
    path: string,
    options?: ListFilesOptions,
  ): Promise<ListFilesResult>;
  exists(path: string): Promise<FileExistsResult>;
  getInfo(): Promise<SandboxInfo>;
  destroy(): Promise<void>;
}

const SANDBOX_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * A real Cloudflare Service Binding (`Fetcher`) is itself an RPC-capable
 * stub: per Workers RPC's "promise pipelining"
 * (https://developers.cloudflare.com/workers/runtime-apis/rpc/), accessing
 * *any* property on it -- including `idFromName` -- speculatively forms an
 * RPC call and answers `typeof` as `"function"`, indistinguishable from a
 * real `DurableObjectNamespace` by presence alone. But such a property
 * isn't a real function: `String(fetcher.idFromName)` is
 * `"[object JsRpcProperty]"`, never function source or
 * `"function ... { [native code] }"` the way a genuine
 * `DurableObjectNamespace.idFromName` (or a hand-written fake used in
 * tests) stringifies. Filtering on that distinguishes the two for real
 * bindings without breaking the structural fakes used in tests/client.test.mjs.
 */
function isRealFunction(value: unknown): value is (...args: unknown[]) => unknown {
  if (typeof value !== "function") return false;
  return !String(value).startsWith("[object ");
}

function isNamespaceTarget(
  target: SandboxTarget,
): target is Extract<SandboxTarget, { idFromName(name: string): unknown }> {
  // workerd tags its binding objects, which is the most direct signal; the
  // function check below only has to cover structural fakes and unknown hosts.
  const tag = Object.prototype.toString.call(target);
  if (tag === "[object DurableObjectNamespace]") return true;
  if (tag === "[object Fetcher]") return false;
  return isRealFunction((target as { idFromName?: unknown }).idFromName);
}

function withoutUndefined(
  envVars: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  return envVars
    ? Object.fromEntries(
        Object.entries(envVars).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : undefined;
}

function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  return btoa(binary);
}

function normalizeEncoding(encoding: FileEncoding): "utf-8" | "base64" {
  return encoding === "utf8" ? "utf-8" : encoding;
}

function toCodeContext(raw: unknown): CodeContext {
  const value = raw as {
    id: string;
    language: string;
    cwd: string;
    createdAt: string;
    lastUsed: string;
  };
  return {
    id: value.id,
    language: value.language,
    cwd: value.cwd,
    createdAt: new Date(value.createdAt),
    lastUsed: new Date(value.lastUsed),
  };
}

function formatsFor(entry: { text?: string; json?: JsonValue }): string[] {
  const formats: string[] = [];
  if (entry.text !== undefined) formats.push("text");
  if (entry.json !== undefined) formats.push("json");
  return formats;
}

/** Combines an explicit signal with a timeout-derived one, when both are present. */
function buildSignal(options: RunCodeOptions): AbortSignal | undefined {
  const timeoutSignal =
    typeof options.timeout === "number"
      ? AbortSignal.timeout(options.timeout)
      : undefined;
  if (options.signal && timeoutSignal) {
    if (typeof AbortSignal.any === "function")
      return AbortSignal.any([options.signal, timeoutSignal]);
    return options.signal;
  }
  return options.signal ?? timeoutSignal;
}

class SandboxClient implements Sandbox {
  constructor(
    private readonly target: SandboxTarget,
    public readonly id: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    if (isNamespaceTarget(this.target)) {
      const headers = new Headers(init.headers);
      headers.set("x-sandbox-id", this.id);
      response = await this.target
        .get(this.target.idFromName(this.id))
        .fetch(new Request(`https://sandbox.internal${path}`, { ...init, headers }));
    } else {
      response = await this.target.fetch(
        new Request(`https://sandbox.internal/sandboxes/${this.id}${path}`, init),
      );
    }
    if (response.status === 204) return {};
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw createErrorFromResponse(undefined, {
        status: response.status,
        statusText: response.statusText,
      });
    }
    if (!response.ok) throw createErrorFromResponse(body);
    return body;
  }

  private async filesOp(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async createCodeContext(
    options: CreateContextOptions = {},
  ): Promise<CodeContext> {
    const envVars = withoutUndefined(options.envVars);
    const body = await this.request("/contexts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(options.language !== undefined ? { language: options.language } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(envVars !== undefined ? { envVars } : {}),
      }),
    });
    return toCodeContext(body);
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    const body = (await this.request("/contexts", { method: "GET" })) as {
      contexts: unknown[];
    };
    return body.contexts.map(toCodeContext);
  }

  async deleteCodeContext(id: string): Promise<void> {
    await this.request(`/contexts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async runCode(
    code: string,
    options: RunCodeOptions = {},
  ): Promise<ExecutionResult> {
    const envVars = withoutUndefined(options.envVars);
    const signal = buildSignal(options);
    const body = await this.request("/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        ...(options.context?.id !== undefined
          ? { contextId: options.context.id }
          : {}),
        ...(options.language !== undefined ? { language: options.language } : {}),
        ...(envVars !== undefined ? { envVars } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { results?: unknown }).results) ||
      typeof (body as { logs?: unknown }).logs !== "object" ||
      (body as { logs?: unknown }).logs === null
    )
      throw new SandboxError({
        code: ErrorCode.INTERNAL_ERROR,
        message: "Invalid sandbox response",
        context: {},
        httpStatus: 500,
        timestamp: new Date().toISOString(),
      });
    const result = body as ExecutionResult;
    if (options.onStdout)
      for (const text of result.logs.stdout ?? [])
        await options.onStdout({ text, timestamp: Date.now() });
    if (options.onStderr)
      for (const text of result.logs.stderr ?? [])
        await options.onStderr({ text, timestamp: Date.now() });
    if (options.onResult)
      for (const entry of result.results ?? [])
        await options.onResult({ ...entry, formats: () => formatsFor(entry) });
    if (result.error && options.onError) await options.onError(result.error);
    return result;
  }

  async setEnvVars(envVars: Record<string, string | undefined>): Promise<void> {
    const payload: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(envVars))
      payload[key] = value === undefined ? null : value;
    await this.request("/env", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envVars: payload }),
    });
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options: WriteFileOptions = {},
  ): Promise<WriteFileResult> {
    const payload =
      content instanceof Uint8Array
        ? { content: toBase64(content), encoding: "base64" as const }
        : {
            content,
            encoding: normalizeEncoding(options.encoding ?? "utf-8"),
          };
    return (await this.filesOp({ op: "write", path, ...payload })) as WriteFileResult;
  }

  async readFile(
    path: string,
    options: ReadFileOptions = {},
  ): Promise<ReadFileResult> {
    return (await this.filesOp({
      op: "read",
      path,
      ...(options.encoding !== undefined
        ? { encoding: normalizeEncoding(options.encoding) }
        : {}),
    })) as ReadFileResult;
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<MkdirResult> {
    return (await this.filesOp({
      op: "mkdir",
      path,
      ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    })) as MkdirResult;
  }

  async deleteFile(
    path: string,
    options: DeleteFileOptions = {},
  ): Promise<DeleteFileResult> {
    return (await this.filesOp({
      op: "delete",
      path,
      ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
      ...(options.force !== undefined ? { force: options.force } : {}),
    })) as DeleteFileResult;
  }

  async renameFile(oldPath: string, newPath: string): Promise<RenameFileResult> {
    return (await this.filesOp({
      op: "rename",
      path: oldPath,
      newPath,
    })) as RenameFileResult;
  }

  async moveFile(
    sourcePath: string,
    destinationPath: string,
  ): Promise<MoveFileResult> {
    return (await this.filesOp({
      op: "move",
      path: sourcePath,
      newPath: destinationPath,
    })) as MoveFileResult;
  }

  async listFiles(
    path: string,
    options: ListFilesOptions = {},
  ): Promise<ListFilesResult> {
    return (await this.filesOp({
      op: "list",
      path,
      ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
      ...(options.includeHidden !== undefined
        ? { includeHidden: options.includeHidden }
        : {}),
    })) as ListFilesResult;
  }

  async exists(path: string): Promise<FileExistsResult> {
    return (await this.filesOp({ op: "exists", path })) as FileExistsResult;
  }

  async getInfo(): Promise<SandboxInfo> {
    return (await this.request("", { method: "GET" })) as SandboxInfo;
  }

  async destroy(): Promise<void> {
    await this.request("", { method: "DELETE" });
  }
}

/**
 * Returns a typed client for one sandbox (a Durable Object, keyed by `id`,
 * inside the runtime Worker). `target` is either a Service Binding to the
 * runtime Worker or a Durable Object namespace bound with `script_name` to
 * it. See docs/sdk-parity-design.md.
 */
export function getSandbox(
  target: SandboxTarget,
  id: string,
  options: SandboxOptions = {},
): Sandbox {
  const normalizedId = options.normalizeId ? id.toLowerCase() : id;
  if (!SANDBOX_ID.test(normalizedId))
    throw new Error(
      `Invalid sandbox id ${JSON.stringify(normalizedId)}: must match ${SANDBOX_ID}`,
    );
  return new SandboxClient(target, normalizedId);
}
