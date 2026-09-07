---
title: HTTP API
description: The raw JSON contract behind the typed client — the runtime Worker's routes, the sandbox's wire protocol, and the gateway paths.
---

**Mode:** both.

`@sandbox-workers/core`'s typed client (see [Lifecycle](/api/lifecycle), [Code interpreter](/api/interpreter), and [Files](/api/files)) sits on top of two separate HTTP contracts: the runtime Worker's own routes (stable, and useful if you call a runtime Worker directly), and the wire protocol between your `Sandbox` Durable Object and that runtime Worker (documented here for completeness — **the `Sandbox` Durable Object's own routes are internal to the client** and not meant to be called directly).

## The runtime Worker's routes

Every `@sandbox-workers/<language>` Worker serves these routes, whether or not it has an `INTERPRETER` Durable Object binding.

### `POST /execute`

Stateless execution, used by stateless mode's free `runCode()` and by the stateful-mode fallback (`sandbox.interpreter.runCode(code, { binding })` against a `contexts: false` binding): a runtime Worker always executes a single language — the runtime is chosen by the Service Binding (or, on the Playground gateway, the URL path), never by the request. Use `Content-Type: application/json`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `code` | string | Yes | Nonempty script; maximum 64 KiB UTF-8 |
| `envVars` | object of string values | No | Environment variables exposed to the script |
| `language` | string | No | Validated, not executed — see below |

The complete request is limited to 96 KiB. `envVars` keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, and every value must be a string; `null`/`undefined` values are skipped. A request that still contains an `input` key is rejected — pass data with `envVars`.

`language`, when given, is only *validated*, never executed with — the runtime Worker always executes its own language. It accepts the same aliases as the typed client (`python3` → `python`, `js`/`node` → `javascript`, `ts` → `typescript`, case-insensitively) and must equal the runtime's language after normalization (`typescript` is also accepted on a `javascript` runtime); otherwise the request 400s with `VALIDATION_FAILED` and a message like `Unsupported language 'python' on this runtime (javascript)`. Omitting `language` entirely always works, on every runtime.

```json
{
  "code": "const x = Number(process.env.X);\nx ** 2",
  "envVars": { "X": "12" }
}
```

Code is a **script**: the value of the last top-level expression is the result. There is no persistent context on this route — every call boots a fresh Wasm instance. For a durable, stateful alternative, see "Code contexts" later on this page.

#### Responses

Every execution — success, a guest error, or a fuel/output/result limit — returns HTTP 200 with an `ExecutionResult` (see [Code interpreter](/api/interpreter#types) for the full shape and the result-mapping rules):

```json
{
  "code": "const x = Number(process.env.X);\nx ** 2",
  "language": "javascript",
  "engine": "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6",
  "durationMs": 8,
  "logs": { "stdout": [], "stderr": [] },
  "results": [{ "text": "144" }],
  "usage": {
    "fuelConsumed": 1800000,
    "fuelLimit": 50000000,
    "memoryBytes": 34668544
  }
}
```

A guest error looks like this instead — `logs` produced before the error are still returned, and `results` is empty:

```json
{
  "code": "1 / 0",
  "language": "python",
  "engine": "CPython 3.14.6",
  "durationMs": 5,
  "logs": { "stdout": [], "stderr": [] },
  "results": [],
  "error": {
    "name": "ZeroDivisionError",
    "message": "division by zero",
    "traceback": ["Traceback (most recent call last):", "..."]
  }
}
```

#### Status codes

| Status | Meaning |
| --- | --- |
| 200 | Every execution: success, a guest error, or a fuel/output/result limit — check `error` |
| 400 | Invalid JSON, an unsupported `/execute/<language>` gateway path, invalid `envVars`, an `input` key in the body, or a `language` that doesn't match the runtime (`VALIDATION_FAILED`) |
| 405 | Wrong HTTP method (`VALIDATION_FAILED`) |
| 413 | Request or code too large (`VALIDATION_FAILED`) |
| 415 | Unsupported Content-Type (`VALIDATION_FAILED`) |
| 502 | Gateway could not call a Service Binding (`INTERNAL_ERROR`) |

Only request/transport failures (400, 405, 413, 415, 502) use a non-200 status, with the body shaped as an `ErrorResponse` (see [Errors](/api/errors)) — `{ "code": "VALIDATION_FAILED", "message": "...", "context": {}, "httpStatus": 400, "timestamp": "..." }`. There is no `ok` field and no 422 status — fuel exhaustion and output/result limits are reported as a 200 response with `error.name` set to `"ExecutionLimitError"`.

Always check the `error` field, not the HTTP status, to see whether guest code succeeded.

### `GET /interpreter`

Served by every runtime Worker without a Durable Object round trip:

```json
{ "language": "python", "engine": "CPython 3.14.6", "contexts": true }
```

`contexts` is `false` for Ruby and for any runtime Worker deployed without an `INTERPRETER` Durable Object binding (the CLI's `--stateless` flag). This is the probe a `Sandbox` Durable Object runs before creating a code context against a binding.

### Code contexts (`/interpreters/:key/*`)

These routes exist only when the runtime Worker has an `INTERPRETER` Durable Object binding (`contexts: true`); otherwise every one of them answers 400 `VALIDATION_FAILED` ("Code contexts are not supported for ruby" / "Code contexts are not supported: this Worker has no INTERPRETER Durable Object binding"). `:key` is the calling `Sandbox` Durable Object's own id (a 64-hex string), so two callers using the same sandbox id against the same runtime Worker never collide; it must match `/^[A-Za-z0-9._-]{1,128}$/`. **These routes are called by the `Sandbox` Durable Object, not directly by application code** — use `sandbox.interpreter.*` (see [Code interpreter](/api/interpreter)) instead.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /interpreters/:key/contexts` | `{ id, cwd }` | `{ id, cwd, createdAt }` (201); 400 when over 8 contexts |
| `DELETE /interpreters/:key/contexts/:id` | | `{ success: true }`; 404 `CONTEXT_NOT_FOUND` |
| `DELETE /interpreters/:key` | | `{ success: true }` — wipes this interpreter's snapshots and contexts |

Context ids are minted by the sandbox and passed in on create — the interpreter never generates its own.

Running code in a context is **not** an HTTP route: it's the Workers RPC method `executeInContext(key, args, getFiles)`, called directly on the runtime Worker binding and forwarded unchanged to `env.INTERPRETER.get(idFromName(key)).executeInContext(key, args, getFiles)`. `args.envVars` arrives flat and already merged (sandbox-level, context-level, and call-level `envVars`, computed by the sandbox) — the interpreter applies it as-is. See [Workspace sync: a pull over RPC](#workspace-sync-a-pull-over-rpc) below.

#### Workspace sync: a pull over RPC

`/workspace` has one source of truth, the `Sandbox` Durable Object; each interpreter keeps an in-memory mirror, reconciled on every `executeInContext` call. `args.workspace` carries the **shape** of `/workspace`, never its contents:

```ts
interface WorkspaceManifest {
  dirs: string[];                    // every directory under /workspace (absolute paths), full list
  manifest: Record<string, string>;  // every file: absolute path -> content hash
  disabled?: boolean;                 // true when this Worker's SANDBOX_FILE_API is "disabled"
}
```

When `SANDBOX_FILE_API=disabled`, the sandbox sends `{ dirs: [], manifest: [], disabled: true }` on every call and `getFiles` returns `[]` for any path it's asked for — nothing is read from or written to the sandbox's `files` table while disabled. The interpreter refuses every read, write, mkdir, delete, rename, and directory listing under `/workspace` with `EACCES` instead of reconciling its mirror. See [Environment variables](/configuration/environment-variables#sandbox_file_api--your-own-worker).

The interpreter reconciles its mirror before running anything: create every directory in `dirs`, delete anything in the mirror that isn't in `manifest`/`dirs`. If `manifest` still names a path the interpreter can't match (it was evicted, or never held this workspace), it calls back `getFiles(missing)` — an RPC stub the sandbox passed as an argument — to pull exactly those paths' contents, then reconciles again. A path still missing after that is `INTERNAL_ERROR`: the sandbox is the interpreter's only source of truth for `/workspace`, so this means the sandbox itself failed to answer `getFiles` correctly, not a race to retry.

`executeInContext` never throws to report an application error — Workers RPC only serializes `name`/`message`/`stack` off a thrown `Error`, which would drop the `code`/details/HTTP status the sandbox needs. Its result is always one of:

```ts
type InterpreterExecuteRpcResult =
  | { ok: true; result: InterpreterExecuteResponse }
  | { ok: false; status: number; body: Record<string, unknown> };  // same shape an ErrorResponse would carry
```

A successful result's `InterpreterExecuteResponse` carries `ExecutionResult`'s fields, the interpreter's own view of the context, and the workspace diff:

```ts
{
  ...ExecutionResult,                    // code, language, engine, durationMs, logs, results, error?, usage?
  executionCount: number,
  context: { id, cwd, executions, snapshotMs?, snapshot: SnapshotInfo | null },
  workspace: {
    dirs: string[];                             // full directory list after the run
    files: Array<{ path; data: Uint8Array; updatedAt }>;  // created or updated by the run
    deleted: string[];                          // files removed by the run
  }
}
```

The `Sandbox` Durable Object applies `workspace` to its own tree, persists the diff, and strips `workspace` (and replaces `context`/`executionCount` with its own registry's view) before answering the caller — see `ExecutionResult.context` in [Code interpreter](/api/interpreter#types) for the shape the client actually sees. Because this is an RPC call rather than an HTTP request, there's no dedicated request-size cap for it — Workers RPC's own 32 MiB serialized-message limit comfortably covers the 16 MiB workspace, and `Uint8Array` file contents need no base64 transcoding on the wire.

## Wire protocol: client → `Sandbox` Durable Object

**Internal to the typed client** — documented here for completeness, not a contract application code should call directly. The client sends `x-sandbox-id: <id>` and talks to `https://sandbox.internal<path>` over the Durable Object namespace given to `getSandbox()`.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /execute` | `{ code, contextId?, binding?, envVars? }` | `ExecutionResult` (+ `executionCount`, `context: { id, cwd, executions, snapshotMs?, expiresAt? }` when a context ran; neither for a stateless binding) |
| `POST /contexts` | `{ binding, cwd?, envVars? }` | `{ id, binding, language, cwd, createdAt, lastUsed }` (201) |
| `GET /contexts` | | `{ contexts: [{ id, binding, language, cwd, createdAt, lastUsed }] }` |
| `DELETE /contexts/:contextId` | | `{ success: true }`; 404 `CONTEXT_NOT_FOUND` |
| `POST /env` | `{ envVars: Record<string, string \| null> }` | `{ success: true }` |
| `POST /files` | `{ op, path, newPath?, content?, encoding?, recursive?, force?, includeHidden? }` | Per operation — see [Files](/api/files); 403 `NOT_SUPPORTED` when `SANDBOX_FILE_API=disabled` |
| `GET /` | | `SandboxInfo` — see [Lifecycle](/api/lifecycle#types) |
| `DELETE /` | | `{ success: true }` — wipes storage and drops every context |

`binding` must match `/^[A-Za-z_][A-Za-z0-9_]*$/` and resolve to a real sandbox-workers runtime Worker (see [Errors: binding validation](/api/errors#binding-validation-errors)).

## Gateway paths

Only the Playground gateway fronts more than one runtime Worker and hosts its own `Sandbox` Durable Object; it picks a runtime from the URL path.

- `POST /execute/<language>`, where `<language>` is `javascript`, `python`, `perl`, or `ruby`. `POST /execute` on the gateway is an alias for `/execute/javascript`. An unsupported `<language>` returns 400.
- `/languages/:language/sandboxes/:id` and any further sub-path forward, for `GET`, `POST`, and `DELETE`, to the gateway's **own** `Sandbox` Durable Object keyed by `:id` — the same sandbox id reached through two languages is one sandbox with two contexts, one per binding. For `POST .../contexts` and `POST .../execute`, the JSON body's `binding` is forced to `:language.toUpperCase()` (the gateway's Service Binding names: `JAVASCRIPT`, `PYTHON`, `PERL`, `RUBY`), overriding anything the client sent. Every other sub-path is forwarded unchanged.

### `GET /languages`

The Playground gateway returns `{languages:[...]}` with runtime IDs, names, package versions, engine names, execution modes, capabilities, and configured limits. Individual runtime Workers do not expose this route.

## Raw Service Binding calls

The request URL may use any placeholder hostname — the binding determines the destination Worker. This API provides no host-network capability to the submitted code.
