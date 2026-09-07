# Sandbox SDK 1.0 alignment: design

Status: design accepted 2026-09-06. Supersedes the API surface in
`docs/sdk-parity-design.md` (which mirrored `@cloudflare/sandbox` 0.12.9).
The Durable Object mechanics for memory snapshots (`chunks` table, 1 MiB
chunk writes, throttled alarms) in `docs/sessions-design.md` and
`docs/snapshot-cost-design.md` are unchanged and still apply to the
interpreter Durable Object described below.

## Goal

Make code written against the Sandbox SDK **1.0 preview**
(`@cloudflare/sandbox@next`, documented under
`cloudflare-docs/src/content/docs/sandbox/1-0-preview/`) port to
`@sandbox-workers/core` with few changes, within what a Wasm-only sandbox
can offer:

- The caller exports a `Sandbox` Durable Object class from its **own**
  Worker (`export { Sandbox } from "@sandbox-workers/core"`) and calls
  `getSandbox(env.Sandbox, id)`, exactly as the 1.0 preview does.
- The code interpreter lives at `sandbox.interpreter.*` with the 1.0 method
  names (`createCodeContext`, `runCode`, `listCodeContexts`,
  `deleteCodeContext`). It is **always present**: there is no
  `withInterpreter` attach step and no subclassing.
- A code context is bound to a **runtime Worker** (one language each:
  `@sandbox-workers/javascript`, `python`, `perl`, `ruby`) by the **name of
  a Service Binding** in the caller's own environment, passed to
  `createCodeContext({ binding: "PYTHON" })`. There is no `language`
  option anywhere: the binding determines the language.
- The binding name is narrowed at the type level, not just validated at
  runtime: `getSandbox<Env>(env.Sandbox, id)` types `binding` options as
  `ServiceBindingName<Env>`, so a misspelled name is a compile-time error.
- One sandbox can hold contexts of **several languages** at once, all
  sharing the sandbox's single `/workspace`.

Out of scope, as before: `exec`/processes, terminals, ports, tunnels,
backups, mounts, `runCodeStream`, file watching, git. Breaking changes to
the unpublished 0.1.0 API, the HTTP protocol, and stored Durable Object
formats are accepted (old storage is wiped, not migrated).

## Model

```text
Caller Worker (your app, or the Playground gateway)
  ├── getSandbox(env.Sandbox, "user-42")            @sandbox-workers/core client
  └── Sandbox Durable Object  (class from @sandbox-workers/core, no Wasm)
        owns: /workspace (files + directories), envVars, context registry, idle expiry
        │  env[context.binding].executeInContext(key, { code, envVars, workspace manifest }, getFiles)  (RPC)
        ▼
Runtime Worker, one per language   (@sandbox-workers/<language>, deployed privately)
  ├── POST /execute                stateless, unchanged
  ├── GET  /interpreter            { language, engine, contexts }
  └── Interpreter Durable Object   (was `Sandbox`; renamed in place)
        owns: per-context memory snapshots (chunks), an in-memory workspace mirror
```

| Sandbox SDK 1.0 preview | Here |
| --- | --- |
| `export { Sandbox } from "@cloudflare/sandbox"`; `getSandbox(env.Sandbox, id)` | Same, from `@sandbox-workers/core`. `env.Sandbox` is the caller's own Durable Object namespace for that class |
| Container behind the sandbox | One **interpreter Durable Object per (sandbox, runtime Worker)** inside each runtime Worker, keyed by the sandbox Durable Object's own id |
| `withInterpreter(this)` on a subclass, then `sandbox.interpreter.*` | `sandbox.interpreter.*` always exists; no attach, no subclass |
| `createCodeContext({ language, cwd })` | `createCodeContext({ binding, cwd?, envVars? })` — `binding` is the name of a Service Binding to a runtime Worker |
| `runCode(code, { context?, language? })` — default context per language | `runCode(code, { context?, binding?, envVars? })` — default context per **binding** |
| Container filesystem shared by every context | `/workspace` owned by the sandbox Durable Object, mirrored into each interpreter on demand |
| Files, `setEnvVars`, `destroy` on `sandbox` | Same names and shapes as `docs/sdk-parity-design.md` (unchanged) |

**Sandbox** = the core `Sandbox` Durable Object, keyed by the caller-chosen
sandbox id. It owns:

- `meta` table: key `sandbox` → `{ format: 1, id, createdAt, lastUsed, envVars, lifetime }`
- `files` table: `path TEXT PRIMARY KEY, data BLOB, updated_at INTEGER`. A
  row with `data IS NULL` is a **directory**, so empty directories now
  survive eviction (they did not before).
- `contexts` table: `id TEXT PRIMARY KEY, value TEXT` — JSON
  `{ id, binding, language, engine, cwd, envVars, createdAt, lastUsed, executions, snapshot }`.
  `snapshot` is the `SnapshotInfo` last reported by the interpreter
  (`{ build, pages, bytes, storedBytes, takenAt, stale } | null`), so
  `getInfo()` never has to ask a runtime Worker.
- The idle-expiry alarm (`SANDBOX_IDLE_TTL_MS` from the **caller's**
  `vars`; default 24 h; `"0"` disables), with the same throttled policy as
  `docs/snapshot-cost-design.md`, "Alarm policy". Expiry and `destroy()`
  wipe storage and, best-effort, `DELETE /interpreters/<key>` on every
  binding referenced by a context.

No Wasm and no `/workspace` mount live in this Durable Object; it is plain
TypeScript in `packages/core/src/sandbox.ts`. It does **not** extend
`cloudflare:workers`'s `DurableObject` (a plain class with
`constructor(state, env)`, `fetch()`, and `alarm()`), so the core package
still has no build-time dependency on Workers types.

**Interpreter** = the runtime Worker's Durable Object (`runtime/interpreter.mjs`,
renamed from `runtime/sandbox.mjs`; `createInterpreterClass(engine)`,
exported as `Interpreter` by the JavaScript, Python, and Perl packages).
Keyed by the **sandbox Durable Object's own id** (`ctx.id.toString()` of
the core object, a 64-hex string), so two callers using the same sandbox id
against the same runtime Worker never collide. It owns:

- `meta` table: key `interpreter` → `{ format: 4, key, build, createdAt, lastUsed, lifetime }`
- `contexts` table: `{ id, cwd, createdAt, lastUsed, executions, snapshot }`
  (context ids are **minted by the sandbox** and passed in)
- `chunks` table: unchanged (per-context 1 MiB snapshot chunks)
- an **in-memory only** workspace mirror (`Workspace`), rebuilt from the
  sandbox's sync payload after eviction; there is no `files` table any more
- the interpreter-side idle alarm (`INTERPRETER_IDLE_TTL_MS`, renamed from
  `SESSION_IDLE_TTL_MS`; same defaults), which wipes this object's
  snapshots. Set it to at least the caller's `SANDBOX_IDLE_TTL_MS`;
  otherwise a context's globals can be gone (`ContextNotFoundError`) while
  the sandbox still lists it.

Any stored format other than 4 (a `files` table, a `meta` row under
`sandbox`/`session`, `format < 4`) is wiped on first access, as every
previous format change did. `engine/wrangler*.jsonc` rename the class in
place: `{ "tag": "v3", "renamed_classes": [{ "from": "Sandbox", "to": "Interpreter" }] }`;
templates and the CLI start at `{ "tag": "v1", "new_sqlite_classes": ["Interpreter"] }`
with binding name `INTERPRETER`.

**Ruby** and any runtime Worker deployed `--stateless` (no `INTERPRETER`
binding) report `contexts: false` from `GET /interpreter`. For such a
binding `createCodeContext` fails with 400 `VALIDATION_FAILED`
("Code contexts are not supported by binding 'RUBY' (ruby)"), and
`runCode(code, { binding })` runs **statelessly** through the runtime's
plain `POST /execute` — no context, no `/workspace`, and the result has no
`context` field. Sandbox-level `envVars` still apply.

**Resident instances, MAX_CONTEXTS.** Unchanged: at most one interpreter
instance resident per interpreter Durable Object; at most 8 contexts per
**sandbox** (enforced by the sandbox; the interpreter keeps its own 8 cap
as a backstop).

**Env vars.** Execution env = `{ ...sandbox.envVars, ...context.envVars, ...call.envVars }`,
computed in the sandbox and sent flat to the interpreter. `setEnvVars`
semantics unchanged (`undefined`/`null` unsets). `envVars` on
`createCodeContext` and `runCode` are extensions over the 1.0 preview
(which has none on the interpreter) and are kept.

**Default context.** `runCode` without `context` requires `binding`
(otherwise 400 `VALIDATION_FAILED` "Pass a context or a binding"). The
default context for a binding is the oldest existing context with that
`binding`, created (`cwd: "/workspace"`, no envVars) when none exists.

## Workspace mirror and sync protocol

`/workspace` has one source of truth: the sandbox Durable Object. Each
interpreter keeps a mirror in memory so guest code sees ordinary files
through WASI / the JS `fs` host functions, exactly as before. The mirror is
brought up to date **inside every `executeInContext` call** and the guest's
changes flow back in the result. Directories are part of the sync (the
`Workspace` class gains directory support in `manifest()`/`serialize()`/
`load()`, see "Workspace module").

The context execute path is a **pull over Workers RPC**, not an HTTP push:
the sandbox never sends file contents unless the interpreter asks for them.
This replaces the earlier push-plus-resync handshake (the sandbox tracking a
`sent: Map<binding, manifest>` of what each interpreter was last known to
hold, sending only the diff, and retrying once on a `resync` response) with
something simpler and race-free, made possible by three facts about Workers
RPC: a function passed as an RPC argument becomes a stub the callee can call
back during that call (auto-disposed once the call returns); a stub received
over RPC may be forwarded over RPC again to another Worker/Durable Object;
and `Uint8Array` is directly serializable, so file contents need no base64
transcoding on the wire.

`Sandbox.handleExecute` calls the binding directly as an RPC method:

```ts
target.executeInContext(key, { contextId, code, envVars, workspace }, getFiles)
```

`workspace` (`WorkspaceManifest`) is the **shape** of `/workspace`, never its
contents:

```ts
interface WorkspaceManifest {
  dirs: string[];                    // every directory under /workspace (absolute paths), full list
  manifest: Record<string, string>;  // every file: absolute path -> content hash (Workspace.hashBytes)
  disabled?: boolean;                 // true when this Worker's SANDBOX_FILE_API is "disabled"
}
```

**`SANDBOX_FILE_API`** (caller `vars`; unset or any other value = enabled,
`"disabled"` turns it off) is read by the `Sandbox` Durable Object, not
passed through to guest code as an env var. When disabled, the sandbox
skips its `files` table entirely (no read on `executeInContext`, no write
of the returned diff) and always sends `{ dirs: [], manifest: [],
disabled: true }`; every HTTP file route (`POST /files`) answers 403
`NOT_SUPPORTED` (`context: { feature: "files" }`) instead of touching
storage. The interpreter treats `disabled: true` as an instruction to
refuse every `/workspace` read, write, mkdir, delete, rename, and directory
listing with `EACCES`, regardless of what its own mirror currently holds —
this requires a runtime Worker built after this flag was added; an older
one ignores `disabled` and reconciles as usual, but since the sandbox never
persists anything while disabled, guest writes are silently lost rather
than exposed with `EACCES`. `sandbox.getInfo()` reports `fileApi: false` in
this state, with `workspace` fixed at `{ files: 0, bytes: 0 }`.

`getFiles` is a plain closure over the sandbox's in-memory `workspace`:
`(paths: string[]) => WorkspaceFileEntry[]`, `WorkspaceFileEntry` being
`{ path, data: Uint8Array, updatedAt }`. It does a synchronous raw byte read
per requested path and omits any path it doesn't recognize (never throws);
it touches no Durable Object storage. Because `Sandbox.fetch` serializes
every request through its own promise chain, the workspace cannot change
while an `executeInContext` call is in flight, so `getFiles` is race-free
without any locking of its own.

The interpreter reconciles its mirror **before** running anything:

1. create every directory in `dirs` (recursive), then delete every file in
   the mirror that is not in `manifest`, then delete every directory in the
   mirror that is not in `dirs` (deepest first) — via
   `Workspace.applySync({ dirs, files: [], manifest })`, which also returns
   `missing`: every manifest path whose hash still doesn't match;
2. if `missing` is non-empty (a fresh interpreter, or one evicted since its
   last execute), call `getFiles(missing)` once, validate what comes back
   (each entry's `path` must be one of the requested paths, `data` a
   `Uint8Array`, `updatedAt` a number), and apply it with a second
   `applySync`. If paths are *still* missing after that — the sandbox itself
   failed to provide them — the call fails with `INTERNAL_ERROR` (there is no
   retry: the sandbox is the interpreter's only source of truth for
   `/workspace`, so a second gap is a bug, not a race).

`executeInContext`'s result (`InterpreterExecuteRpcResult`) reports errors as
values, not thrown exceptions:

```ts
type InterpreterExecuteRpcResult =
  | { ok: true; result: InterpreterExecuteResponse }
  | { ok: false; status: number; body: Record<string, unknown> };
```

This is a direct consequence of how Workers RPC serializes a thrown `Error`:
only `name`/`message`/`stack` survive the trip, which would silently drop
the `code`/`details`/HTTP status the sandbox relies on to decide what to do
next (`errorBody`/`errnoErrorBody` in `packages/core/src/protocol.ts` build
the same `{ status, body }` shape the HTTP error responses use, so both
transports share one source of truth for error shaping). On `ok: false`,
`CONTEXT_NOT_FOUND` makes the sandbox drop the registry row and answer 404;
every other error is relayed unchanged (the same status and body the HTTP
protocol would have produced).

A successful result's `InterpreterExecuteResponse.workspace`
(`InterpreterSyncResponse`) is the diff produced by the run:

```ts
{
  ...ExecutionResult,                    // code, language, engine, durationMs, logs, results, error?, usage?
  context: { id, cwd, executions, snapshotMs?, snapshot: SnapshotInfo | null },
  workspace: {
    dirs: string[];                             // full directory list after the run
    files: Array<{ path; data: Uint8Array; updatedAt }>;  // created or updated by the run
    deleted: string[];                          // files removed by the run
  }
}
```

The sandbox applies `workspace` to its own tree (same order as above) and
persists the resulting file/directory diff in one transaction together with
the context row. A guest error already makes the interpreter roll its mirror
back to the pre-run state (`Workspace.restoreFrom`, unchanged), so the
result then carries no changes. Interpreter execution is serialized per
Durable Object and sandbox execution per sandbox, so nothing but eviction
can make an interpreter's mirror diverge from the manifest — which the
`getFiles` pull covers, every time, without a dedicated retry protocol.

File operations through `sandbox.writeFile()` and friends touch only the
sandbox's tree; the next execute on each binding pulls whatever that
binding's interpreter turns out to be missing. Nothing is pushed eagerly.

## Wire protocol: client → sandbox Durable Object

The client calls `env.Sandbox.get(env.Sandbox.idFromName(id)).fetch(new Request("https://sandbox.internal<path>", ...))`
with header `x-sandbox-id: <id>`, as the Durable Object transport did in
`docs/sdk-parity-design.md`. The Service Binding transport for
`getSandbox` is **removed** (a runtime Worker no longer has `/sandboxes`
routes); `getSandbox` throws synchronously unless `target.idFromName` is a
real function (same `isRealFunction` check as before).

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /execute` | `{ code, contextId?, binding?, envVars? }` | `ExecutionResult` (+ `executionCount`, `context: { id, cwd, executions, snapshotMs?, expiresAt? }` when a context ran; neither for a stateless binding) |
| `POST /contexts` | `{ binding, cwd?, envVars? }` | `{ id, binding, language, cwd, createdAt, lastUsed }` (201) |
| `GET /contexts` | | `{ contexts: [{ id, binding, language, cwd, createdAt, lastUsed }] }` |
| `DELETE /contexts/:contextId` | | `{ success: true }`; 404 `CONTEXT_NOT_FOUND` |
| `POST /env` | `{ envVars: Record<string, string \| null> }` | `{ success: true }` |
| `POST /files` | unchanged (`op`, `path`, …); 403 `NOT_SUPPORTED` when `SANDBOX_FILE_API=disabled` | unchanged |
| `GET /` | | `SandboxInfo` |
| `DELETE /` | | `{ success: true }` |

`SandboxInfo` becomes

```ts
interface SandboxInfo {
  id: string; createdAt: string; lastUsed: string;
  envVars: Record<string, string>;
  contexts: Array<{ id; binding; language; engine; cwd; createdAt; lastUsed; executions; snapshot: SnapshotInfo | null }>;
  fileApi: boolean;                              // false when SANDBOX_FILE_API=disabled
  workspace: { files: number; bytes: number };   // files counts entries (files + directories), as today; always { files: 0, bytes: 0 } when fileApi is false
  expiresAt: number | null;
}
```

(no sandbox-level `language`/`engine` any more — a sandbox has no single
language).

`binding` validation in the sandbox: must match `/^[A-Za-z_][A-Za-z0-9_]*$/`,
`env[binding]` must be an object with a `fetch` function (this excludes the
`Sandbox` namespace itself and every non-service binding), and
`GET /interpreter` on it must return JSON `{ language, engine, contexts }`;
otherwise 400 `VALIDATION_FAILED` ("Unknown binding 'X'" / "Binding 'X' is
not a sandbox-workers runtime Worker"). The probe happens on
`createCodeContext` and on default-context creation only, never per
execute.

`POST /execute` flow in the sandbox:

1. Validate the body (`code` non-empty ≤ 64 KiB, `envVars`, `contextId`
   string, `binding` name). `cwd` is rejected as before.
2. Resolve the context: by `contextId` (404 `CONTEXT_NOT_FOUND`), else by
   `binding` (default context, see above; for a `contexts: false` binding
   go to the stateless path and return), else 400.
3. Build the workspace manifest (`{ dirs, manifest }`, no contents) and a
   `getFiles` closure over the sandbox's own workspace (see "Workspace
   mirror and sync protocol").
4. Call `target.executeInContext(key, { contextId, code, envVars, workspace }, getFiles)`
   as an RPC method on the binding. A thrown error (transport failure, or the
   binding predates `executeInContext`) becomes 502 `INTERNAL_ERROR`
   ("Binding 'X' failed: ..."). An `{ ok: false }` result with
   `CONTEXT_NOT_FOUND` deletes the registry row and rethrows as 404
   `CONTEXT_NOT_FOUND`; any other `{ ok: false }` is relayed unchanged (same
   status and body an HTTP `ErrorResponse` would carry).
5. Apply `workspace`, update the context row (`cwd`, `executions`,
   `lastUsed`, `snapshot`), persist, touch the alarm, respond.

## Wire protocol: sandbox Durable Object → runtime Worker

Every route except the context execute path is still
`env[binding].fetch(new Request("https://sandbox.internal<path>", ...))`.
The runtime Worker forwards `/interpreters/:key/...` to
`env.INTERPRETER.get(idFromName(key))` with the prefix stripped and header
`x-interpreter-key: <key>` (`key` must match `/^[A-Za-z0-9._-]{1,128}$/`).
Every route answers `ErrorResponse` on failure.

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /interpreter` | | `{ language, engine, contexts: boolean }` — served by every runtime Worker, no Durable Object involved. `contexts` is `false` for Ruby and for a Worker without an `INTERPRETER` binding |
| `POST /interpreters/:key/contexts` | `{ id, cwd }` | `{ id, cwd, createdAt }` (201); 400 when over 8 contexts |
| `DELETE /interpreters/:key/contexts/:id` | | `{ success: true }`; 404 `CONTEXT_NOT_FOUND` |
| `DELETE /interpreters/:key` | | `{ success: true }` — wipes snapshots and contexts |
| `POST /execute` | `{ code, envVars?, language? }` | unchanged stateless execution |

The context execute path is **not** one of these HTTP routes: it is the RPC
method `executeInContext(key, args, getFiles)`, called directly on the
binding (`target.executeInContext(...)`, where `target` is the same
Service Binding used for `fetch` above) and forwarded, unchanged, by the
runtime Worker's `WorkerEntrypoint.executeInContext` to
`env.INTERPRETER.get(idFromName(key)).executeInContext(key, args, getFiles)`
— the `getFiles` stub travels across both hops. `args` is
`InterpreterExecuteArgs` (`{ contextId, code, envVars, workspace }`); the
result is `InterpreterExecuteRpcResult` (`{ ok: true, result } | { ok: false,
status, body }`), detailed in "Workspace mirror and sync protocol" above.
Because it is an RPC method rather than an HTTP route, there is no
dedicated request-size cap for it — Workers RPC's own 32 MiB serialized
message limit comfortably covers a 16 MiB workspace.

A runtime Worker without an `INTERPRETER` binding (Ruby always; others
with `--stateless`) answers every `/interpreters/*` HTTP request with 400
`VALIDATION_FAILED` ("Code contexts are not supported for ruby" /
"Code contexts are not supported: this Worker has no INTERPRETER Durable
Object binding"), and its `executeInContext` RPC method returns the same
error as `{ ok: false, status: 400, body }`. The old `/sandboxes/:id/*`
routes, the context-less stateless `execute` under them,
`handleStatelessSandboxRoute`, and `readExecution`'s `rejectContextId`
option are removed.

The interpreter's `executeInContext` method keeps everything
`runtime/sandbox.mjs`'s old `_execute` did (ensure instance, restore from
chunks, run, snapshot, chunk diff, persist in one transaction) minus the
`files` table, plus the mirror reconciliation (create dirs, pull whatever's
missing via `getFiles`, delete what's no longer wanted) before the run and
the workspace diff (via `Workspace.changes(since)` against the post-sync
manifest) in the result. `cwd` reported by the guest is persisted in the
interpreter's context row and echoed to the sandbox, which mirrors it.

## Workspace module

`runtime/workspace.mjs` moves to **`packages/core/src/workspace.ts`**
(converted to TypeScript; `@bjorn3/browser_wasi_shim` becomes a
`dependencies` entry of `@sandbox-workers/core`) and is exported from the
package root (`Workspace`, `WorkspaceError`, `WorkspaceDirectory`,
`WorkspaceFile`, `WORKSPACE_TAG`, `LIMITS`, `hashBytes`). `runtime/workspace.mjs`
becomes a one-line re-export (`export * from "@sandbox-workers/core"`) so
`runtime/wasi.mjs`, `runtime/javascript.mjs`, and the existing tests keep
their import path. Because the runtime modules now import the built core
package, the root `test` script builds core first
(`pnpm --filter @sandbox-workers/core build && node --test tests/*.test.mjs`).

Additions to `Workspace`:

- `manifest()` → `{ dirs: string[], files: Record<string, string> }`:
  every directory (absolute, sorted, root excluded) and every file's hash.
- `serialize()` also emits directories as `{ path, data: null, updatedAt: 0 }`
  rows; `load(rows)` creates a directory for a `data === null` row (and
  still creates missing parents for files). `changes(since)` keeps
  tracking files only; callers that persist directories diff
  `manifest().dirs` against what they last stored.
- `applySync({ dirs, files, deleted, manifest? })` implementing the
  reconciliation order above in place (keeping `root` identity, as
  `restoreFrom` does), returning `{ missing: string[] }` when a `manifest`
  is given. Used by both sides.

Behavior of every existing operation is unchanged.

## Typed client (`@sandbox-workers/core`)

```ts
import { getSandbox, runCode, Sandbox } from "@sandbox-workers/core";
export { Sandbox };                                       // the Durable Object class, from the caller's entry

const sandbox = getSandbox<Env>(env.Sandbox, "user-42");  // SandboxClient<ServiceBindingName<Env>>; binding options below are narrowed to Env's Service Bindings
const py = await sandbox.interpreter.createCodeContext({ binding: "PYTHON", cwd: "/workspace", envVars: { A: "1" } });
const js = await sandbox.interpreter.createCodeContext({ binding: "JAVASCRIPT" });
await sandbox.interpreter.runCode("open('/workspace/a.txt','w').write('hi')", { context: py });
await sandbox.interpreter.runCode("fs.readFileSync('/workspace/a.txt','utf8')", { context: js });
await sandbox.interpreter.runCode("1 + 1", { binding: "PYTHON" });   // default context for PYTHON
await sandbox.interpreter.listCodeContexts();
await sandbox.interpreter.deleteCodeContext(py.id);
await sandbox.setEnvVars({ TOKEN: "abc", OLD: undefined });
await sandbox.writeFile("/workspace/a.txt", "hi");          // files API unchanged
await sandbox.getInfo();
await sandbox.destroy();

await runCode(env.PYTHON, "1 + 1", { envVars });            // stateless, unchanged (Service Binding only)
```

```ts
export type SandboxNamespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
export interface SandboxOptions { normalizeId?: boolean }

// Any environment: every binding name is allowed, so ServiceBindingName<AnyEnv> is `string`.
export type AnyEnv = Record<string, ServiceBindingTarget>;
// The names of the Service Bindings (Fetcher-like values, i.e. anything with a `fetch` method) in Env.
export type ServiceBindingName<Env> = { [K in keyof Env & string]: Env[K] extends ServiceBindingTarget ? K : never }[keyof Env & string];

export function getSandbox<Env = AnyEnv>(namespace: SandboxNamespace, id: string, options?: SandboxOptions): SandboxClient<ServiceBindingName<Env>>;

export interface CreateContextOptions<B extends string = string> { binding: B; cwd?: string; envVars?: Record<string, string | undefined> }
export interface CodeContext { readonly id: string; readonly binding: string; readonly language: string; readonly cwd: string; readonly createdAt: Date; readonly lastUsed: Date }
export interface RunCodeOptions<B extends string = string> {
  context?: CodeContext; binding?: B;
  envVars?: Record<string, string | undefined>;
  timeout?: number; signal?: AbortSignal;
  onStdout?; onStderr?; onResult?; onError?;              // unchanged, fired after the response
}
export interface CodeInterpreter<B extends string = string> {
  createCodeContext(options: CreateContextOptions<B>): Promise<CodeContext>;
  listCodeContexts(): Promise<CodeContext[]>;
  deleteCodeContext(id: string): Promise<void>;
  runCode(code: string, options?: RunCodeOptions<B>): Promise<ExecutionResult>;
}
export interface SandboxClient<B extends string = string> {
  readonly id: string;
  readonly interpreter: CodeInterpreter<B>;
  setEnvVars(envVars: Record<string, string | undefined>): Promise<void>;
  writeFile / readFile / mkdir / deleteFile / renameFile / moveFile / listFiles / exists;   // unchanged
  getInfo(): Promise<SandboxInfo>;
  destroy(): Promise<void>;
}
export class Sandbox { constructor(state: unknown, env: unknown); fetch(request: Request): Promise<Response>; alarm(): Promise<void> }
export type StatelessRunCodeOptions = Omit<RunCodeOptions, "context" | "binding">;
export function runCode(target: { fetch(request: Request): Promise<Response> }, code: string, options?: StatelessRunCodeOptions): Promise<ExecutionResult>;
```

`B` (default `string`) is the caller's binding-name type: `getSandbox<Env>()` instantiates it to `ServiceBindingName<Env>`, so `sandbox.interpreter`'s `binding` options are checked against `Env`'s Service Bindings at compile time; plain `getSandbox(namespace, id)` (no `Env`) keeps `B` as `string`, exactly as before this existed. `CodeContext.binding` stays plain `string` regardless -- it's data read back from the Durable Object, not a caller-supplied value to narrow.

The client interface is named `SandboxClient` because `Sandbox` is the
Durable Object class (the 1.0 preview uses `Sandbox` for the class too).
`SandboxTarget`, `SandboxLanguage`, and the Service Binding transport are
removed; `validateSandboxId` stays. Errors (`ErrorCode`, `SandboxError`
subclasses, `createErrorFromResponse`, `Operation`) are unchanged.
`ExecutionResult` is unchanged (its `language`/`engine` are the runtime's).

## Caller configuration

```jsonc
// caller wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "JAVASCRIPT", "service": "sandbox-javascript" },
  ],
  "vars": {
    "SANDBOX_IDLE_TTL_MS": "86400000",   // optional; "0" disables expiry
    // "SANDBOX_FILE_API": "disabled",   // optional; turns the File API off (see "Workspace mirror and sync protocol" below)
  },
}
```

```ts
// caller entry
export { Sandbox } from "@sandbox-workers/core";
```

```jsonc
// runtime Worker wrangler.jsonc (templates, CLI): binding renamed
{
  "durable_objects": { "bindings": [{ "name": "INTERPRETER", "class_name": "Interpreter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Interpreter"] }],
  "vars": { "INTERPRETER_IDLE_TTL_MS": "86400000" },
}
```

```js
// runtime Worker entry (templates, CLI): export { default, Interpreter } from "@sandbox-workers/<language>";
```

`--stateless` (and Ruby) omit the Durable Object and export only `default`.
`scripts/build-packages.mjs` writes the matching `worker.d.ts`
(`Interpreter` class, optional `INTERPRETER` binding).

## Gateway (Playground) and UI

The gateway becomes an ordinary caller: `src/index.ts` re-exports
`Sandbox` from `@sandbox-workers/core`, and `wrangler.jsonc` adds the
`Sandbox` Durable Object binding, its `v1` migration, and
`vars.SANDBOX_IDLE_TTL_MS: "3600000"`. `/languages/:language/sandboxes/:id[/...]`
(GET, POST, DELETE) now maps to the gateway's **own** sandbox: `:language`
must be one of the four runtimes, `binding = :language.toUpperCase()`
(the gateway's existing Service Binding names), and for `POST .../contexts`
and `POST .../execute` the JSON body gets `binding` set to that value
(overriding anything the client sent) before the request is forwarded to
`env.Sandbox.get(idFromName(:id)).fetch(...)` with `x-sandbox-id`. Every
other sub-path is forwarded unchanged. The same sandbox id reached through
two languages is therefore one sandbox with two bindings — the UI keeps
one generated id per language so it never mixes them. `/execute[/lang]`
and `/languages` are unchanged.

The deployed gateway's `wrangler.jsonc` also sets
`vars.SANDBOX_FILE_API: "disabled"`, so nothing written to `/workspace`
through the public Playground is ever stored. `ui/main.js` reads `fileApi`
off `GET /`'s `SandboxInfo` and hides the Workspace tab when it is `false`,
rather than hard-coding the gateway's own configuration into the UI.

UI (`ui/main.js`): no protocol change is needed (`GET` info still has
`contexts[0].executions/cwd/snapshot` and `expiresAt`). Only the
"connect your application" snippet is updated to the new client API.
`ui/index.html`/`ui/style.css` are untouched.

## Deployment

- `engine/wrangler*.jsonc`: binding `INTERPRETER` / class `Interpreter`,
  migration `v3` `renamed_classes` `Sandbox` → `Interpreter`, var
  `INTERPRETER_IDLE_TTL_MS`.
- `engine/index.ts`, `engine/{python,perl}.ts`: `export { default, Interpreter } from "@sandbox-workers/<language>"`.
- Templates (`scripts/generate-templates.mjs`, `scripts/template-readme.md`),
  CLI (`packages/cli/bin/cli.mjs`): as in "Caller configuration"; READMEs
  show the caller snippet (`export { Sandbox }`, `getSandbox(env.Sandbox, id)`,
  `sandbox.interpreter.createCodeContext({ binding })`) and the caller's
  `wrangler.jsonc` blocks. (Since 2026-09-07 the CLI's runtime argument is a
  comma-separated list, generating one `wrangler.<runtime>.jsonc` +
  `<runtime>.js` per runtime in one project; see
  `docs/sdk-parity-design.md`.)
- `package.json` scripts: `dev:caller` / `test:caller` replace
  `dev:do-binding` / `test:do-binding` (the caller fixture now binds two
  runtime Workers, JavaScript and Python).

## Tests

- `tests/workspace.test.mjs`: unchanged cases plus `manifest()`,
  directory rows in `serialize()`/`load()`, and `applySync` (order,
  `missing`, root identity).
- `tests/sessions.test.mjs`, `tests/snapshot-chunks.test.mjs`,
  `tests/engine.test.mjs`, `tests/languages.test.mjs`: unchanged.
- `tests/client.test.mjs`: rewritten for `getSandbox(namespace, id)` only
  (a Service Binding target throws), `sandbox.interpreter.*`, `binding` in
  request bodies, `context.binding`, default-context `binding`, the
  free `runCode`, error mapping (unchanged).
- `tests/sandbox-do.test.mjs` (new, pure Node): the core `Sandbox` Durable
  Object driven through `fetch()` with a fake `state` (an in-memory SQLite
  substitute is not available — implement a minimal fake of
  `storage.sql.exec` over a `Map`, or use `node:sqlite` (`DatabaseSync`,
  Node ≥ 22.5) behind the same `exec(query, ...params)` shape) and fake
  runtime bindings that record `/interpreter`, `/interpreters/...` HTTP
  requests plus each `executeInContext`/`getFiles` RPC call: context
  creation and registry, default context per binding, stateless fallback
  for `contexts: false`, the `getFiles` pull (one call per execute only
  when something's missing, exactly the missing paths, nothing after
  eviction with no simulated resync), a short `getFiles` answer producing
  `INTERNAL_ERROR`, `CONTEXT_NOT_FOUND` propagation from an `{ ok: false }`
  result, unknown binding, expiry cleanup calling `DELETE /interpreters/<key>`.
- `tests/sandboxes.mjs` (gateway, `wrangler dev`): same scenarios through
  the same URLs, `SandboxInfo` shape updated, plus a **cross-language**
  scenario: one id via `/languages/javascript/...` and `/languages/python/...`;
  a JavaScript context writes `/workspace/shared.txt` with `fs.writeFileSync`,
  the Python context reads it with `open()`, `GET` shows two contexts with
  different `binding`s, `files` `list` from either path shows the file;
  an empty directory created with `mkdir` is visible to guest code.
- `tests/sandboxes-restart.mjs`: unchanged in spirit (routes unchanged).
- `tests/caller.mjs` + `tests/fixtures/caller/` (replace `do-binding`): a
  caller Worker exporting `Sandbox`, bound to `sandbox-engine-javascript`
  (`JAVASCRIPT`) and `sandbox-engine-python` (`PYTHON`), driving the typed
  client end to end: contexts in both languages sharing a file, default
  context by binding, `ContextNotFoundError`, `ValidationFailedError` for
  an unknown binding and for `runCode` without context/binding, files API,
  `getInfo`, `destroy`. `pnpm run dev:caller` starts the three Workers.
- `tests/stateless.mjs` + fixture: `runCode` unchanged; the raw checks
  become `GET /interpreter` → `contexts: false` and
  `POST /interpreters/x/contexts` → 400.
- `tests/cli.test.mjs`, `tests/package.mjs`: `Interpreter`/`INTERPRETER`
  expectations; the package smoke test drives `getSandbox` against a fake
  namespace and the new paths/bodies.

## Docs

`website/content` is rewritten to describe this model (the 1.0 preview
docs are the style reference): `get-started.md` (caller exports `Sandbox`,
binds a runtime, `sandbox.interpreter.runCode(code, { binding })`),
`guides/{code-contexts,manage-files,execute-code,deploy}.md`,
`api/{lifecycle,interpreter,files,errors,http-api}.md` (the HTTP page now
documents the runtime Worker's `/execute`, `/interpreter`, and
`/interpreters/*` routes and the gateway paths; the sandbox object's own
routes are internal to the client), `concepts/{architecture,sandboxes,code-contexts}.md`,
`configuration/{wrangler,transport → bindings,environment-variables}.md`
(`transport.md` becomes `bindings.md`: the `Sandbox` Durable Object
binding, runtime Service Bindings, `SANDBOX_IDLE_TTL_MS` vs
`INTERPRETER_IDLE_TTL_MS`), `platform/limits.md`. `packages/core/README.md`,
`packages/<language>/README.md`, `README.md`, `docs/runtime.md`, and the
template README follow. `docs/sdk-parity-design.md` gets a "Superseded by
`docs/sandbox-1-0-design.md`" note at the top.
