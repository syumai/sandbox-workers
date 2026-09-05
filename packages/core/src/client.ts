import type { ExecutionResult, LanguageEngine } from "./protocol.js";
export type { JsonValue } from "./protocol.js";
export interface RunCodeOptions {
  envVars?: Record<string, string | undefined>;
}
/** Same id pattern enforced by a session-capable runtime Worker. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** HTTP/transport failures are distinct from a guest execution failure (`error` on the result). */
export class SandboxTransportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "SandboxTransportError";
  }
}
/**
 * A file operation failure reported by the session's files API (see
 * `docs/sessions-design.md`). Distinct from `SandboxTransportError`, which
 * covers binding/network failures and malformed responses.
 */
export class SandboxFileError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "SandboxFileError";
  }
}
export interface SessionRunCodeOptions extends RunCodeOptions {
  cwd?: string;
}
export interface SessionExecutionResult extends ExecutionResult {
  session: { id: string; cwd: string; executions: number };
}
export interface SessionInfo {
  id: string;
  language: string;
  engine: string;
  cwd: string;
  createdAt: number;
  lastUsed: number;
  executions: number;
  workspace: { files: number; bytes: number };
  snapshot: { pages: number; bytes: number; build: string } | null;
}
export type FileEncoding = "utf-8" | "base64";
export interface FileEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  updatedAt: number;
}
export interface FileStat {
  type: "file" | "directory";
  size: number;
  updatedAt: number;
}
export interface ReadFileResult {
  content: string;
  size: number;
  encoding: FileEncoding;
  isBinary: boolean;
  updatedAt: number;
}
export interface ReadFileOptions {
  encoding?: FileEncoding;
}
export interface WriteFileOptions {
  encoding?: FileEncoding;
}
export interface ListFilesOptions {
  recursive?: boolean;
}
export interface DeleteFileOptions {
  recursive?: boolean;
  force?: boolean;
}
export interface MkdirOptions {
  recursive?: boolean;
}
/** A named, durable REPL over one runtime Worker's Durable Object. See `createSandbox(...).session(id)`. */
export interface SandboxSession {
  readonly id: string;
  runCode(
    code: string,
    options?: SessionRunCodeOptions,
  ): Promise<SessionExecutionResult>;
  info(): Promise<SessionInfo>;
  reset(): Promise<void>;
  destroy(): Promise<void>;
  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>;
  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<{ size: number }>;
  listFiles(path?: string, options?: ListFilesOptions): Promise<FileEntry[]>;
  deleteFile(path: string, options?: DeleteFileOptions): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
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
function isFileErrorBody(
  body: unknown,
): body is { error: { name: "FileError"; code: string; message: string } } {
  return (
    !!body &&
    typeof body === "object" &&
    "error" in body &&
    !!body.error &&
    typeof body.error === "object" &&
    "name" in body.error &&
    body.error.name === "FileError" &&
    "code" in body.error &&
    typeof body.error.code === "string" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  );
}
function errorMessage(body: unknown): string {
  return body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
    ? body.error.message
    : "Sandbox request failed";
}
async function sessionCall(
  binding: LanguageEngine,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await binding.fetch(
    new Request(`https://sandbox.internal${path}`, init),
  );
  let body: unknown;
  try {
    body = response.status === 204 ? {} : await response.json();
  } catch {
    throw new SandboxTransportError(
      response.status,
      "Sandbox returned a non-JSON response",
    );
  }
  if (!response.ok) {
    if (isFileErrorBody(body))
      throw new SandboxFileError(
        body.error.code,
        body.error.message,
        response.status,
      );
    throw new SandboxTransportError(response.status, errorMessage(body));
  }
  return body;
}
async function fileOp(
  binding: LanguageEngine,
  id: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  return sessionCall(binding, `/sessions/${id}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
function createSession(
  binding: LanguageEngine,
  language: string,
  id: string,
): SandboxSession {
  if (!SESSION_ID.test(id))
    throw new Error(
      `Invalid session id ${JSON.stringify(id)}: must match ${SESSION_ID}`,
    );
  return {
    id,
    async runCode(code, options = {}) {
      const envVars = withoutUndefined(options.envVars);
      const body = await sessionCall(
        binding,
        `/sessions/${id}/execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            language,
            code,
            ...(envVars ? { envVars } : {}),
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          }),
        },
      );
      if (
        !body ||
        typeof body !== "object" ||
        !("results" in body) ||
        !Array.isArray((body as { results: unknown }).results) ||
        !("logs" in body) ||
        typeof (body as { logs: unknown }).logs !== "object" ||
        (body as { logs: unknown }).logs === null
      )
        throw new SandboxTransportError(200, "Invalid sandbox response");
      return body as SessionExecutionResult;
    },
    async info() {
      return (await sessionCall(binding, `/sessions/${id}`, {
        method: "GET",
      })) as SessionInfo;
    },
    async reset() {
      await sessionCall(binding, `/sessions/${id}/reset`, { method: "POST" });
    },
    async destroy() {
      await sessionCall(binding, `/sessions/${id}`, { method: "DELETE" });
    },
    async readFile(path, options = {}) {
      return (await fileOp(binding, id, {
        op: "read",
        path,
        ...(options.encoding ? { encoding: options.encoding } : {}),
      })) as ReadFileResult;
    },
    async writeFile(path, content, options = {}) {
      const payload =
        content instanceof Uint8Array
          ? { content: toBase64(content), encoding: "base64" as const }
          : {
              content,
              encoding: options.encoding ?? ("utf-8" as const),
            };
      return (await fileOp(binding, id, {
        op: "write",
        path,
        ...payload,
      })) as { size: number };
    },
    async listFiles(path = "/", options = {}) {
      const result = (await fileOp(binding, id, {
        op: "list",
        path,
        ...(options.recursive !== undefined
          ? { recursive: options.recursive }
          : {}),
      })) as { entries: FileEntry[] };
      return result.entries;
    },
    async deleteFile(path, options = {}) {
      await fileOp(binding, id, {
        op: "delete",
        path,
        ...(options.recursive !== undefined
          ? { recursive: options.recursive }
          : {}),
        ...(options.force !== undefined ? { force: options.force } : {}),
      });
    },
    async renameFile(from, to) {
      await fileOp(binding, id, { op: "rename", path: from, newPath: to });
    },
    async mkdir(path, options = {}) {
      await fileOp(binding, id, {
        op: "mkdir",
        path,
        ...(options.recursive !== undefined
          ? { recursive: options.recursive }
          : {}),
      });
    },
    async exists(path) {
      const result = (await fileOp(binding, id, {
        op: "exists",
        path,
      })) as { exists: boolean };
      return result.exists;
    },
    async stat(path) {
      return (await fileOp(binding, id, { op: "stat", path })) as FileStat;
    },
  };
}
/** Only the supplied Service Binding is used; this client never calls a public URL. */
export function createSandbox(
  binding: LanguageEngine,
  language = "javascript",
) {
  return {
    async runCode(
      code: string,
      options: RunCodeOptions = {},
    ): Promise<ExecutionResult> {
      const envVars = options.envVars
        ? Object.fromEntries(
            Object.entries(options.envVars).filter(
              ([, value]) => value !== undefined,
            ),
          )
        : undefined;
      const response = await binding.fetch(
        new Request("https://sandbox.internal/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ language, code, envVars }),
        }),
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SandboxTransportError(
          response.status,
          "Sandbox returned a non-JSON response",
        );
      }
      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          body.error &&
          typeof body.error === "object" &&
          "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : "Sandbox request failed";
        throw new SandboxTransportError(response.status, message);
      }
      if (
        !body ||
        typeof body !== "object" ||
        !("results" in body) ||
        !Array.isArray((body as { results: unknown }).results) ||
        !("logs" in body) ||
        typeof (body as { logs: unknown }).logs !== "object" ||
        (body as { logs: unknown }).logs === null
      )
        throw new SandboxTransportError(
          response.status,
          "Invalid sandbox response",
        );
      return body as ExecutionResult;
    },
    /** A named, durable REPL session on this binding. See `SandboxSession`. */
    session(id: string): SandboxSession {
      return createSession(binding, language, id);
    },
  };
}
