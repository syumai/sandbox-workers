import type { ExecutionError, ExecutionResult, JsonValue } from "./protocol.js";
import { ErrorCode, SandboxError, createErrorFromResponse } from "./errors.js";

/**
 * A Durable Object namespace bound to the caller's own `Sandbox` class (see
 * docs/sandbox-1-0-design.md). Declared structurally so this package doesn't
 * depend on `@cloudflare/workers-types` being installed.
 */
export type SandboxNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

export interface SandboxOptions {
  /** Lowercase `id` before validating/using it. */
  normalizeId?: boolean;
}

/**
 * Any environment: every binding name is allowed, so `ServiceBindingName<AnyEnv>`
 * is `string`. This is the default `Env` for `getSandbox()`, matching today's
 * untyped behavior when no `Env` type argument is given.
 */
export type AnyEnv = Record<string, ServiceBindingTarget>;

/**
 * The names of the Service Bindings (`Fetcher`-like values, i.e. anything with
 * a `fetch` method) in a caller's environment type. Pass an `Env` to
 * `getSandbox<Env>()` and `binding` options are narrowed to this union.
 */
export type ServiceBindingName<Env> = {
  [K in keyof Env & string]: Env[K] extends ServiceBindingTarget ? K : never;
}[keyof Env & string];

export interface CreateContextOptions<B extends string = string> {
  /** Name of a Service Binding, in the caller's own environment, to a runtime Worker. */
  binding: B;
  cwd?: string;
  envVars?: Record<string, string | undefined>;
}
export interface CodeContext {
  readonly id: string;
  readonly binding: string;
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

export interface RunCodeOptions<B extends string = string> {
  context?: CodeContext;
  /** Name of a Service Binding to run against when `context` is omitted (uses/creates the default context for that binding). */
  binding?: B;
  envVars?: Record<string, string | undefined>;
  /** Request timeout; builds an `AbortSignal.timeout(timeout)`. The guest is still bounded by fuel. */
  timeout?: number;
  signal?: AbortSignal;
  onStdout?: (output: OutputMessage) => void | Promise<void>;
  onStderr?: (output: OutputMessage) => void | Promise<void>;
  onResult?: (result: Result) => void | Promise<void>;
  onError?: (error: ExecutionError) => void | Promise<void>;
}

/**
 * Options for the free `runCode(target, code, options?)` function: the same
 * as `RunCodeOptions` minus `context`/`binding`, since a stateless call has
 * no code context and no sandbox to route a binding name through.
 */
export type StatelessRunCodeOptions = Omit<RunCodeOptions, "context" | "binding">;

export type FileEncoding = "utf-8" | "utf8" | "base64" | "none";
export interface WriteFileOptions {
  /** Any string is accepted: "utf8" is normalized to "utf-8"; everything else is forwarded unchanged (the server rejects anything but utf-8/base64). */
  encoding?: string;
}
export interface ReadFileOptions {
  encoding?: Exclude<FileEncoding, "none">;
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
/** Returned by `readFile(path, { encoding: "none" })`: content as a stream of raw bytes. */
export interface ReadFileStreamResult {
  success: true;
  path: string;
  content: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
  timestamp: string;
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
  /** The server currently only ever emits "file" or "directory". */
  type: "file" | "directory" | "symlink" | "other";
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
  createdAt: string;
  lastUsed: string;
  envVars: Record<string, string>;
  contexts: Array<{
    id: string;
    binding: string;
    language: string;
    engine: string;
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
  /** `files` counts entries (files + directories), as before. */
  workspace: { files: number; bytes: number };
  /** False when the caller's Worker sets SANDBOX_FILE_API=disabled: file methods throw NotSupportedError and /workspace is empty, read-only for guests, and never persisted. */
  fileApi: boolean;
  expiresAt: number | null;
}

export interface CodeInterpreter<B extends string = string> {
  createCodeContext(options: CreateContextOptions<B>): Promise<CodeContext>;
  listCodeContexts(): Promise<CodeContext[]>;
  deleteCodeContext(id: string): Promise<void>;
  runCode(code: string, options?: RunCodeOptions<B>): Promise<ExecutionResult>;
}

/**
 * A caller-hosted sandbox: a code interpreter (`sandbox.interpreter`, always
 * present, spanning every language bound in the caller's own environment)
 * plus a shared `/workspace`. Named `SandboxClient` because `Sandbox` is the
 * Durable Object class itself (see docs/sandbox-1-0-design.md).
 *
 * `B` is the union of Service Binding names `binding` options accept; it's
 * `string` by default (untyped `getSandbox()`) or narrowed to
 * `ServiceBindingName<Env>` when the client came from `getSandbox<Env>()`.
 */
export interface SandboxClient<B extends string = string> {
  readonly id: string;
  readonly interpreter: CodeInterpreter<B>;
  setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;
  writeFile(
    path: string,
    content: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: WriteFileOptions,
  ): Promise<WriteFileResult>;
  readFile(
    path: string,
    options: { encoding: "none" },
  ): Promise<ReadFileStreamResult>;
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

const SANDBOX_ID = /^[A-Za-z0-9._-]{1,63}$/;
/**
 * Names that would conflict with well-known subdomains/paths if a sandbox id
 * were ever used to build a hostname (see @cloudflare/sandbox's
 * `sanitizeSandboxId` in packages/sandbox/src/security.ts). Checked
 * case-insensitively.
 */
const RESERVED_SANDBOX_IDS = new Set([
  "www",
  "api",
  "admin",
  "root",
  "system",
  "cloudflare",
  "workers",
]);

/**
 * Validates a sandbox id against the SDK's rules on top of the existing
 * charset: 1-63 characters matching `SANDBOX_ID`, no leading/trailing
 * hyphen, and not one of `RESERVED_SANDBOX_IDS` (case-insensitively). Throws
 * a plain `Error` (not a `SandboxError`) with an SDK-like message. Does not
 * warn about uppercase characters the way the SDK's console warning does.
 */
export function validateSandboxId(id: string): void {
  if (!SANDBOX_ID.test(id))
    throw new Error(
      `Invalid sandbox id ${JSON.stringify(id)}: must match ${SANDBOX_ID}`,
    );
  if (id.startsWith("-") || id.endsWith("-"))
    throw new Error(
      `Invalid sandbox id ${JSON.stringify(id)}: cannot start or end with a hyphen`,
    );
  if (RESERVED_SANDBOX_IDS.has(id.toLowerCase()))
    throw new Error(
      `Invalid sandbox id ${JSON.stringify(id)}: '${id}' is a reserved name`,
    );
}

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

/**
 * `getSandbox` requires a real Durable Object namespace: throws synchronously
 * (a plain `Error`, matching `docs/sandbox-1-0-design.md`) unless
 * `target.idFromName` is a real function.
 */
function assertNamespace(
  target: SandboxNamespace,
): asserts target is SandboxNamespace {
  const tag = Object.prototype.toString.call(target);
  if (tag === "[object DurableObjectNamespace]") return;
  if (isRealFunction((target as { idFromName?: unknown }).idFromName)) return;
  throw new Error(
    "getSandbox() requires a Durable Object namespace bound to the caller's own Sandbox class (see docs/sandbox-1-0-design.md); export { Sandbox } from \"@sandbox-workers/core\" and bind it with durable_objects",
  );
}

/** A `SandboxTarget`-shaped value narrowed to the Service Binding branch, for the free `runCode`. */
export type ServiceBindingTarget = { fetch(request: Request): Promise<Response> };

function isNamespaceShaped(
  target: ServiceBindingTarget | SandboxNamespace,
): target is SandboxNamespace {
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

function normalizeEncoding(encoding: string): string {
  return encoding === "utf8" ? "utf-8" : encoding;
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readStreamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toCodeContext(raw: unknown): CodeContext {
  const value = raw as {
    id: string;
    binding: string;
    language: string;
    cwd: string;
    createdAt: string;
    lastUsed: string;
  };
  return {
    id: value.id,
    binding: value.binding,
    language: value.language,
    cwd: value.cwd,
    createdAt: new Date(value.createdAt),
    lastUsed: new Date(value.lastUsed),
  };
}

function formatsFor(entry: { text?: string; json?: JsonValue }): string[] {
  const formats: string[] = [];
  if (entry.text) formats.push("text");
  if (entry.json) formats.push("json");
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

/**
 * Parses a fetch `Response` into a JSON body, mapping a non-JSON body or a
 * non-2xx status to the matching `SandboxError` subclass (via
 * `createErrorFromResponse`). Shared by `SandboxClientImpl.request` and the
 * free `runCode` function below.
 */
async function parseJsonResponse(response: Response): Promise<unknown> {
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

/**
 * Builds the JSON body for `POST .../execute`, omitting unset keys and
 * dropping `undefined` env values. Shared by `SandboxClientImpl.runCode` and
 * the free `runCode` function (whose options never carry `context`/`binding`).
 */
function buildExecutionRequestBody(
  code: string,
  options: RunCodeOptions,
): Record<string, unknown> {
  const envVars = withoutUndefined(options.envVars);
  return {
    code,
    ...(options.context?.id !== undefined ? { contextId: options.context.id } : {}),
    ...(options.binding !== undefined ? { binding: options.binding } : {}),
    ...(envVars !== undefined ? { envVars } : {}),
  };
}

/** Validates the shape of a parsed `/execute` response body. */
function validateExecutionResult(body: unknown): ExecutionResult {
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
  return body as ExecutionResult;
}

/**
 * Fires `onStdout`/`onStderr`/`onResult`/`onError` in order, after the
 * response has arrived (there is no streaming). Shared by
 * `SandboxClientImpl.runCode` and the free `runCode` function.
 */
async function dispatchRunCodeCallbacks(
  result: ExecutionResult,
  options: RunCodeOptions,
): Promise<void> {
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
}

class CodeInterpreterImpl implements CodeInterpreter {
  constructor(private readonly client: SandboxClientImpl) {}

  async createCodeContext(options: CreateContextOptions): Promise<CodeContext> {
    const envVars = withoutUndefined(options.envVars);
    const body = await this.client.request("/contexts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        binding: options.binding,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(envVars !== undefined ? { envVars } : {}),
      }),
    });
    return toCodeContext(body);
  }

  async listCodeContexts(): Promise<CodeContext[]> {
    const body = (await this.client.request("/contexts", { method: "GET" })) as {
      contexts: unknown[];
    };
    return body.contexts.map(toCodeContext);
  }

  async deleteCodeContext(id: string): Promise<void> {
    await this.client.request(`/contexts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async runCode(code: string, options: RunCodeOptions = {}): Promise<ExecutionResult> {
    const signal = buildSignal(options);
    const body = await this.client.request("/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildExecutionRequestBody(code, options)),
      ...(signal ? { signal } : {}),
    });
    const result = validateExecutionResult(body);
    await dispatchRunCodeCallbacks(result, options);
    return result;
  }
}

class SandboxClientImpl implements SandboxClient {
  readonly interpreter: CodeInterpreter = new CodeInterpreterImpl(this);

  constructor(
    private readonly namespace: SandboxNamespace,
    public readonly id: string,
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("x-sandbox-id", this.id);
    const response = await this.namespace
      .get(this.namespace.idFromName(this.id))
      .fetch(new Request(`https://sandbox.internal${path}`, { ...init, headers }));
    return parseJsonResponse(response);
  }

  private async filesOp(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
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
    content: string | Uint8Array | ReadableStream<Uint8Array>,
    options: WriteFileOptions = {},
  ): Promise<WriteFileResult> {
    let payload: { content: string; encoding: string };
    if (content instanceof Uint8Array) {
      payload = { content: toBase64(content), encoding: "base64" };
    } else if (content instanceof ReadableStream) {
      payload = { content: toBase64(await readStreamToBytes(content)), encoding: "base64" };
    } else {
      payload = {
        content,
        encoding: normalizeEncoding(options.encoding ?? "utf-8"),
      };
    }
    return (await this.filesOp({ op: "write", path, ...payload })) as WriteFileResult;
  }

  readFile(path: string, options: { encoding: "none" }): Promise<ReadFileStreamResult>;
  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>;
  async readFile(
    path: string,
    options: ReadFileOptions | { encoding: "none" } = {},
  ): Promise<ReadFileResult | ReadFileStreamResult> {
    if (options.encoding === "none") {
      const body = (await this.filesOp({
        op: "read",
        path,
        encoding: "base64",
      })) as ReadFileResult;
      const bytes = fromBase64(body.content);
      return {
        success: true,
        path: body.path,
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        size: body.size ?? bytes.byteLength,
        mimeType: body.mimeType ?? "application/octet-stream",
        timestamp: body.timestamp,
      };
    }
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
    return (await this.request("/", { method: "GET" })) as SandboxInfo;
  }

  async destroy(): Promise<void> {
    await this.request("/", { method: "DELETE" });
  }
}

/**
 * Returns a typed client for one sandbox: a `Sandbox` Durable Object (the
 * class exported by this package, re-exported from the caller's own entry),
 * keyed by `id`, inside `namespace` -- the caller's own Durable Object
 * namespace binding for that class. See docs/sandbox-1-0-design.md.
 *
 * Pass your Worker's own `Env` type as the `Env` type parameter (e.g.
 * `getSandbox<Env>(env.Sandbox, id)`) and every `binding` option on
 * `sandbox.interpreter` is narrowed to `ServiceBindingName<Env>` -- the names
 * of the Service Bindings (values with a `fetch` method) in `Env` -- so a
 * misspelled binding name or the `Sandbox` namespace itself is a compile-time
 * error. `Env` can't be inferred from `namespace` alone, so omitting it (as
 * in plain `getSandbox(namespace, id)`) falls back to `string`, exactly as
 * before this type parameter existed.
 */
export function getSandbox<Env = AnyEnv>(
  namespace: SandboxNamespace,
  id: string,
  options: SandboxOptions = {},
): SandboxClient<ServiceBindingName<Env>> {
  assertNamespace(namespace);
  const normalizedId = options.normalizeId ? id.toLowerCase() : id;
  validateSandboxId(normalizedId);
  // SandboxClientImpl always implements SandboxClient<string>: its methods
  // never actually check the `binding` string beyond forwarding it over the
  // wire, so narrowing to a subset of `string` here is a type-level-only
  // cast, sound because `ServiceBindingName<Env>` is always a subset of `string`.
  return new SandboxClientImpl(namespace, normalizedId) as SandboxClient<
    ServiceBindingName<Env>
  >;
}

async function runCodeOverServiceBinding(
  target: ServiceBindingTarget,
  code: string,
  options: StatelessRunCodeOptions,
): Promise<ExecutionResult> {
  const signal = buildSignal(options);
  const response = await target.fetch(
    new Request("https://sandbox.internal/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildExecutionRequestBody(code, options)),
      ...(signal ? { signal } : {}),
    }),
  );
  const body = await parseJsonResponse(response);
  const result = validateExecutionResult(body);
  await dispatchRunCodeCallbacks(result, options);
  return result;
}

/**
 * Runs code statelessly against a runtime Worker: a fresh Wasm instance per
 * call, no code context, no files -- the plain `POST /execute` route (see
 * docs/sandbox-1-0-design.md). Unlike `getSandbox(namespace, id).interpreter.runCode()`,
 * `target` must be a Service Binding (`Fetcher`) to the runtime Worker, not a
 * Durable Object namespace -- there is no sandbox id to route through here.
 *
 * This function validates `target` synchronously (it is not declared
 * `async`), so a namespace-shaped `target` throws immediately rather than
 * rejecting the returned promise.
 */
export function runCode(
  target: ServiceBindingTarget | SandboxNamespace,
  code: string,
  options: StatelessRunCodeOptions = {},
): Promise<ExecutionResult> {
  if (isNamespaceShaped(target))
    throw new Error(
      "runCode() requires a Service Binding to a runtime Worker; use getSandbox(namespace, id).interpreter.runCode() with a Durable Object namespace",
    );
  return runCodeOverServiceBinding(target, code, options);
}
