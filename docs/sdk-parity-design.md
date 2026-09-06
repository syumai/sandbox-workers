# Sandbox SDK API parity: design

Status: design accepted 2026-09-06. Supersedes the session-layer API in
`docs/sessions-design.md` (the Durable Object internals — workspace tables,
memory snapshots, idle expiry — are unchanged and still documented there;
only the API surface around them changes).

## Goal

Make code written against `@cloudflare/sandbox` (checked against 0.12.9)
port to `@sandbox-workers/core` with few changes. The entry point, the code
interpreter methods, the file methods, and the error classes match the SDK
in name, argument order, and return shape. Fine-grained options may differ
(documented in `website/content/reference/api.md`). Breaking changes to the
unpublished 0.1.0 API and to the HTTP protocol are accepted.

Explicitly out of scope: shell/process APIs (`exec`, `startProcess`, …),
`createSession`/`ExecutionSession` (a shell session), git, ports, buckets,
backups, terminals, `runCodeStream`, `readFileStream`, `watch`,
`checkChanges`.

## Model

| SDK | Here |
| --- | --- |
| `getSandbox(env.Sandbox, id, options)` — one container-backed Durable Object per `id` | `getSandbox(env.SANDBOX, id, options)` — one Durable Object per `id` inside the runtime Worker. `env.SANDBOX` is either a **Service Binding** to the runtime Worker or a **Durable Object namespace** bound with `script_name` to the runtime Worker's `Sandbox` class |
| Code context (`createCodeContext`) with a generated id, held in container memory | Code context with a generated id, persisted in the sandbox's Durable Object (meta + memory snapshot per context) |
| Container filesystem shared by all contexts | One `/workspace` per sandbox, shared by all of its contexts |
| Language per context (`python`, `javascript`, `typescript`) | Language fixed per runtime Worker; `language` is validated against it (`typescript` is accepted by the JavaScript runtime) |

A **sandbox** = Durable Object `Sandbox` (renamed from `SandboxSession`),
keyed by the caller-chosen sandbox id. It owns:

- `meta`: `{ format: 2, id, language, build, createdAt, lastUsed, envVars, lifetime }`
- `files` table (unchanged from sessions-design)
- `contexts` table: `id TEXT PRIMARY KEY, value TEXT` — JSON
  `{ id, language, cwd, envVars, createdAt, lastUsed, executions }`
- `pages` table gains a context column: `context_id TEXT, page INTEGER, data BLOB, PRIMARY KEY (context_id, page)`
- per-context snapshot record in `meta` under key `snapshot:<contextId>` (same record shape as today)

Old-format storage (a `meta` row with key `session`, no `format`) is wiped
on first access (`deleteAll` + recreate tables). Sessions created before
this change are discarded; nothing is migrated.

**Resident instances.** At most `MAX_RESIDENT_CONTEXTS = 1` interpreter
instance is kept in memory per Durable Object. Executing in another context
snapshots/drops the resident one first (it is restored from its snapshot on
next use). `MAX_CONTEXTS = 8` contexts per sandbox (`createCodeContext`
beyond that fails with `VALIDATION_FAILED`).

**Default context.** `runCode` without `context` (and without `contextId`
on the wire) uses the first existing context whose language matches
`options.language ?? runtime language`, creating one if none exists — the
SDK's `getOrCreateDefaultContext` semantics, done server-side.

**Ruby.** Ruby has no Durable Object. Its runtime Worker still answers
`POST /sandboxes/:id/execute` **without** `contextId` by running the code
statelessly (same as `/execute`) and returns the `ExecutionResult` without a
`context` field. Every other `/sandboxes/*` route, and `execute` with a
`contextId`, answers 400 `VALIDATION_FAILED` "Code contexts are not
supported for ruby".

**Env vars.** Execution env = `{ ...sandbox.envVars, ...context.envVars, ...call.envVars }`.
`setEnvVars` persists into `meta.envVars` (an `undefined` value unsets the
key, per the SDK). Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, values must
be strings.

## Typed client (`@sandbox-workers/core`)

```ts
import { getSandbox, type Sandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.SANDBOX, "user-42");           // Fetcher or DurableObjectNamespace
const ctx = await sandbox.createCodeContext({ cwd: "/workspace", envVars: { A: "1" } });
const result = await sandbox.runCode("x = 1\nx + 1", { context: ctx });
await sandbox.runCode("console.log(1)");                       // default context for the runtime's language
await sandbox.listCodeContexts();
await sandbox.deleteCodeContext(ctx.id);
await sandbox.setEnvVars({ TOKEN: "abc", OLD: undefined });
await sandbox.writeFile("/workspace/a.txt", "hi");             // string or Uint8Array
await sandbox.readFile("/workspace/a.txt", { encoding: "utf-8" });
await sandbox.mkdir("/workspace/dir", { recursive: true });
await sandbox.deleteFile("/workspace/a.txt");                  // { recursive, force } are an extension
await sandbox.renameFile("/workspace/a.txt", "/workspace/b.txt");
await sandbox.moveFile("/workspace/b.txt", "/workspace/dir/b.txt");
await sandbox.listFiles("/workspace", { recursive: true, includeHidden: false });
await sandbox.exists("/workspace/dir/b.txt");
await sandbox.getInfo();                                       // extension
await sandbox.destroy();
```

```ts
export type SandboxTarget = Fetcher | DurableObjectNamespace-like;
export interface SandboxOptions { normalizeId?: boolean }        // subset of the SDK's
export function getSandbox(target: SandboxTarget, id: string, options?: SandboxOptions): Sandbox;
```

- The transport is chosen by workerd's binding tag
  (`Object.prototype.toString.call(target)`: `[object Fetcher]` vs
  `[object DurableObjectNamespace]`), falling back to "has a real `idFromName`
  function" for structural fakes. Presence of `idFromName` alone is NOT enough:
  a Service Binding is an RPC stub whose every property reads as a function.
- `Fetcher` (Service Binding): requests go to `https://sandbox.internal/sandboxes/<id>/...`.
- `DurableObjectNamespace`: the client calls `target.get(target.idFromName(id)).fetch(...)` with the
  `x-sandbox-id: <id>` header and the path **without** the `/sandboxes/<id>`
  prefix (the same request the runtime Worker forwards internally).
- `id` must match `/^[A-Za-z0-9._-]{1,128}$/` after optional lowercasing
  (`normalizeId`); otherwise `getSandbox` throws synchronously.

### Types

The SDK's names, re-declared here (no dependency on `@cloudflare/sandbox`):

```ts
export type SandboxLanguage = "python" | "javascript" | "typescript" | "perl" | "ruby";

export interface CreateContextOptions { language?: SandboxLanguage; cwd?: string; envVars?: Record<string, string | undefined> }
export interface CodeContext { readonly id: string; readonly language: string; readonly cwd: string; readonly createdAt: Date; readonly lastUsed: Date }

export interface RunCodeOptions {
  context?: CodeContext;
  language?: SandboxLanguage;
  envVars?: Record<string, string | undefined>;
  timeout?: number;                 // request timeout (AbortSignal.timeout); the guest is still bounded by fuel
  signal?: AbortSignal;             // forwarded to fetch
  onStdout?: (output: OutputMessage) => void | Promise<void>;   // called once per stdout line, after the response arrives
  onStderr?: (output: OutputMessage) => void | Promise<void>;
  onResult?: (result: Result) => void | Promise<void>;
  onError?: (error: ExecutionError) => void | Promise<void>;
}
export interface OutputMessage { text: string; timestamp: number }
export interface Result { text?: string; json?: JsonValue; formats(): string[] }
export interface ExecutionError { name: string; message: string; traceback: string[]; lineNumber?: number }
export interface ExecutionResult {
  code: string;
  logs: { stdout: string[]; stderr: string[] };
  results: Array<{ text?: string; json?: JsonValue }>;
  error?: ExecutionError;
  executionCount?: number;
  // extensions
  language: string; engine: string; durationMs: number;
  usage?: { fuelConsumed: number; fuelLimit: number; memoryBytes: number };
  context?: { id: string; cwd: string; executions: number; snapshotMs?: number; expiresAt?: number };
}

export type FileEncoding = "utf-8" | "utf8" | "base64";
export interface WriteFileResult { success: boolean; path: string; timestamp: string }
export interface ReadFileResult { success: boolean; path: string; content: string; timestamp: string; encoding?: "utf-8" | "base64"; isBinary?: boolean; mimeType?: string; size?: number }
export interface MkdirResult { success: boolean; path: string; recursive: boolean; timestamp: string }
export interface DeleteFileResult { success: boolean; path: string; timestamp: string }
export interface RenameFileResult { success: boolean; path: string; newPath: string; timestamp: string }
export interface MoveFileResult { success: boolean; path: string; newPath: string; timestamp: string }
export interface FileExistsResult { success: boolean; path: string; exists: boolean; timestamp: string }
export interface FileInfo { name: string; absolutePath: string; relativePath: string; type: "file" | "directory"; size: number; modifiedAt: string; mode: string; permissions: { readable: boolean; writable: boolean; executable: boolean } }
export interface ListFilesOptions { recursive?: boolean; includeHidden?: boolean }
export interface ListFilesResult { success: boolean; path: string; files: FileInfo[]; count: number; timestamp: string }

export interface SandboxInfo {   // extension
  id: string; language: string; engine: string; createdAt: string; lastUsed: string;
  envVars: Record<string, string>;
  contexts: Array<CodeContext-on-the-wire & { executions: number; snapshot: { build: string; pages: number; bytes: number; takenAt: string; stale: boolean } | null }>;
  workspace: { files: number; bytes: number };
  expiresAt: number | null;
}
```

`timestamp`, `createdAt`, `lastUsed`, `modifiedAt`, `takenAt` are ISO-8601
strings on the wire; the client converts `CodeContext.createdAt/lastUsed` to
`Date` like the SDK does. `expiresAt` (extension) stays epoch milliseconds.

### Errors

```ts
export const ErrorCode = {
  FILE_NOT_FOUND: "FILE_NOT_FOUND",          // 404
  FILE_EXISTS: "FILE_EXISTS",                // 409
  PERMISSION_DENIED: "PERMISSION_DENIED",    // 403
  IS_DIRECTORY: "IS_DIRECTORY",              // 400
  NOT_DIRECTORY: "NOT_DIRECTORY",            // 400
  FILE_TOO_LARGE: "FILE_TOO_LARGE",          // 413
  NO_SPACE: "NO_SPACE",                      // 507
  FILESYSTEM_ERROR: "FILESYSTEM_ERROR",      // 400 (ENOTEMPTY and anything else)
  CONTEXT_NOT_FOUND: "CONTEXT_NOT_FOUND",    // 404
  VALIDATION_FAILED: "VALIDATION_FAILED",    // 400 (also used with 413/415/405 for request-shape failures)
  CODE_EXECUTION_ERROR: "CODE_EXECUTION_ERROR", // 500 (engine failed before producing a result)
  INTERNAL_ERROR: "INTERNAL_ERROR",          // 500 / non-JSON response
} as const;

export interface ErrorResponse<TContext = Record<string, unknown>> {
  code: ErrorCode; message: string; context: TContext; httpStatus: number; timestamp: string; operation?: string;
}

export class SandboxError<TContext = Record<string, unknown>> extends Error {
  constructor(public readonly errorResponse: ErrorResponse<TContext>, options?: { cause?: unknown });
  get code(); get context(); get httpStatus(); get timestamp(); get operation(); toJSON();
}
export class FileNotFoundError extends SandboxError<{ path: string; operation: string }> {}
export class FileExistsError extends SandboxError<{ path: string; operation: string }> {}
export class FileTooLargeError extends SandboxError<{ path: string; operation: string; maxSize: number; actualSize: number }> {}
export class PermissionDeniedError extends SandboxError<{ path: string; operation: string }> {}
export class FileSystemError extends SandboxError<{ path: string; operation: string }> {}
export class ContextNotFoundError extends SandboxError<{ contextId: string }> {}
export class ValidationFailedError extends SandboxError<{ validationErrors?: Array<{ field: string; message: string }> }> {}
export class CodeExecutionError extends SandboxError<{ contextId?: string; ename?: string; evalue?: string }> {}
export function createErrorFromResponse(body: ErrorResponse, options?: { cause?: unknown }): SandboxError;
```

Each subclass sets `this.name` to its class name. `createErrorFromResponse`
maps `code` to the subclass, falling back to `SandboxError` (name
`SandboxError`) for anything else (`NO_SPACE`, `IS_DIRECTORY`,
`NOT_DIRECTORY`, `FILESYSTEM_ERROR` → `FileSystemError`). A non-JSON or
non-object error body becomes `SandboxError` with `INTERNAL_ERROR` and
`message: "HTTP <status>: <statusText>"`, like the SDK.

Server side, `errorResponse(error)` (in `protocol.ts`) now always emits the
`ErrorResponse` shape. `ApiError(status, message, code = VALIDATION_FAILED, context = {})`
keeps its name; `WorkspaceError` codes map as: `ENOENT→FILE_NOT_FOUND`,
`EEXIST→FILE_EXISTS`, `EACCES→PERMISSION_DENIED`, `EISDIR→IS_DIRECTORY`,
`ENOTDIR→NOT_DIRECTORY`, `EFBIG→FILE_TOO_LARGE`, `ENOSPC→NO_SPACE`,
`ENOTEMPTY`/other→`FILESYSTEM_ERROR`. The Node-style code is kept in
`context.errno` (e.g. `context: { path, operation, errno: "ENOTEMPTY" }`).

Removed: `createSandbox`, `SandboxSession` (client type), `SandboxTransportError`,
`SandboxFileError`, `SessionInfo`, `FileEntry`, `FileStat`, `stat()`,
`reset()`, `session()`.

## HTTP API of a runtime Worker

Stateless `POST /execute` is unchanged in request/response shape, except
that error bodies use `ErrorResponse`. All sandbox routes are under
`/sandboxes/:id` (id pattern as above). The runtime Worker forwards them to
`env.SANDBOX.get(idFromName(id))` with the prefix stripped and header
`x-sandbox-id: <id>`, exactly as the session routes were forwarded.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sandboxes/:id/execute` | `{ code, contextId?, language?, envVars? }` | `ExecutionResult` (+ `executionCount`, `context`); always 200 for guest errors |
| `POST /sandboxes/:id/contexts` | `{ language?, cwd?, envVars? }` | `{ id, language, cwd, createdAt, lastUsed }` (201) |
| `GET /sandboxes/:id/contexts` | | `{ contexts: [{ id, language, cwd, createdAt, lastUsed }] }` |
| `DELETE /sandboxes/:id/contexts/:contextId` | | `{ success: true }`; 404 `CONTEXT_NOT_FOUND` |
| `POST /sandboxes/:id/env` | `{ envVars: Record<string, string \| null> }` (`null` unsets; the client sends `undefined` values as `null`) | `{ success: true }` |
| `POST /sandboxes/:id/files` | `{ op, path, newPath?, content?, encoding?, recursive?, force?, includeHidden? }` | Per op, below |
| `GET /sandboxes/:id` | | `SandboxInfo` |
| `DELETE /sandboxes/:id` | | `{ success: true }` — wipes storage, drops instances |

`op` is `read`, `write`, `mkdir`, `delete`, `rename`, `move`, `list`, or
`exists` (`stat` is removed). `rename` and `move` are the same operation
(SDK exposes both; `move` additionally requires the destination's parent to
exist — both do here). Results:

| `op` | Response |
| --- | --- |
| `read` | `{ success, path, content, encoding, isBinary, mimeType, size, timestamp }` |
| `write` | `{ success, path, timestamp }` |
| `mkdir` | `{ success, path, recursive, timestamp }` |
| `delete` | `{ success, path, timestamp }` — a directory needs `recursive: true` (SDK refuses directories entirely); `force: true` ignores a missing path |
| `rename` / `move` | `{ success, path, newPath, timestamp }` |
| `list` | `{ success, path, files: FileInfo[], count, timestamp }` — hidden entries (name starts with `.`) are omitted unless `includeHidden` |
| `exists` | `{ success, path, exists, timestamp }` |

`path` in responses is the normalized absolute path. `FileInfo`:
`name` (basename), `absolutePath`, `relativePath` (relative to the listed
directory, `/`-separated), `type`, `size` (0 for directories), `modifiedAt`
(ISO; directories use the sandbox's `createdAt`), `mode` (`-rw-r--r--` for
files, `drwxr-xr-x` for directories), `permissions` (`readable: true,
writable: true, executable: type === "directory"`). `mimeType` is derived
from the extension with a small table (`.json`, `.js/.mjs`, `.py`, `.pl`,
`.rb`, `.txt/.md`, `.html`, `.css`, `.csv`, `.png`, `.jpg/.jpeg`, `.gif`,
`.svg`, `.pdf`, `.wasm`, `.zip`, `.gz`); unknown → `text/plain` when not
binary, else `application/octet-stream`.

`execute` details: `language`, when present, must equal the runtime
language (`typescript` also accepted on `javascript`) → otherwise 400
`VALIDATION_FAILED`. `contextId` must exist → otherwise 404
`CONTEXT_NOT_FOUND`. `cwd` is no longer accepted on `execute` (it is a
context property; guest `chdir` still updates the context's `cwd`). The
response `context` block replaces the old `session` block, with the same
`snapshotMs`/`expiresAt` rules. `executionCount` is the context's
`executions` after this run.

Limits, idle expiry (`SESSION_IDLE_TTL_MS`, unchanged name), snapshot
rules: unchanged from `docs/sessions-design.md`; expiry deletes the whole
sandbox (all contexts and files).

## Gateway (Playground)

`src/index.ts` forwards `/languages/:language/sandboxes/:id[/...]` (GET,
POST, DELETE) to the runtime binding as `/sandboxes/:id[/...]`, replacing
the `/sessions/` route. `/execute[/lang]` and `/languages` are unchanged.

## UI (Playground)

REPL mode keeps one Playground-generated **sandbox id** per language
(storage key `sandboxIds`; the old `sessionIds` key is ignored) and always
runs in the default context (no `contextId`). Info comes from `GET
.../sandboxes/:id` (the first context's `executions`, `cwd`, `snapshot`;
`expiresAt`). "New session" deletes the sandbox; "Reset" deletes every
context listed by `GET .../contexts` (files stay). Workspace tab uses
`op: "list"` → `files[].absolutePath`, `op: "read"`, `op: "write"`, `op:
"delete"`. Error bodies are `ErrorResponse` (`json.message`). Keep the UI
diff as small as possible: another checkout is concurrently renaming
"Session" → "REPL" in `ui/index.html`/`ui/style.css`; do not touch those
two files.

## Deployment

- Each session-capable package exports `Sandbox` (was `SandboxSession`);
  entrypoints become `export { default, Sandbox } from "@sandbox-workers/<language>"`.
  Binding name `SANDBOX` (was `SESSIONS`).
- `engine/wrangler*.jsonc` (already deployed with `SandboxSession` under
  `v1`): keep `v1` and add `{ "tag": "v2", "renamed_classes": [{ "from": "SandboxSession", "to": "Sandbox" }] }`.
- Templates, CLI initializer, `scripts/generate-templates.mjs`,
  `scripts/build-packages.mjs` (worker.d.ts): `{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }`.
- Caller Worker, option A (Service Binding, unchanged):
  `"services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }]`.
- Caller Worker, option B (Durable Object namespace, SDK-shaped):
  `"durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox", "script_name": "sandbox-javascript" }] }`
  (no migration in the caller; the class lives in the runtime Worker).

## Tests

- `tests/client.test.mjs` (new, pure Node): `getSandbox` against a fake
  `Fetcher` and a fake `DurableObjectNamespace` — request paths/headers/bodies
  for every method, `Date` conversion, `Uint8Array` → base64, callbacks,
  `signal`/`timeout` forwarding, `createErrorFromResponse` mapping, the
  non-JSON fallback.
- `tests/sandboxes.mjs` (replaces `tests/sessions.mjs`; `pnpm run
  test:sessions` → `test:sandboxes`): the same scenarios re-expressed
  through the new routes, plus contexts (create/list/delete, isolation of
  globals between two contexts, shared workspace between contexts, default
  context reuse), `setEnvVars` layering, `moveFile`, `includeHidden`, Ruby's
  stateless `execute` and 400 for contexts, old-format storage being wiped
  is not testable over HTTP (skip).
- `tests/sessions.test.mjs`, `tests/workspace.test.mjs`: unchanged (runtime
  modules keep their contract).
- `tests/do-binding.mjs` + `tests/fixtures/do-binding/`: a caller Worker that
  drives `getSandbox` over both transports (`pnpm run dev:do-binding`, then
  `pnpm run test:do-binding`). workerd tags bindings as
  `[object DurableObjectNamespace]` / `[object Fetcher]`; the client checks
  that tag first because a Service Binding's RPC stub answers `typeof
  target.idFromName === "function"` too (promise pipelining).
- `tests/sandboxes-restart.mjs` (was `tests/sessions-restart.mjs`): the
  two-phase restart test, unchanged in spirit.
