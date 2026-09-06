---
title: Code interpreter
description: Create code contexts bound to a runtime Worker and run code with the typed client.
---

**Mode:** `sandbox.interpreter.*` is stateful mode; the free `runCode()` function (below) is stateless mode. See [Stateless mode](/stateless) and [Stateful mode](/stateful).

`sandbox.interpreter` is always present on a `SandboxClient` — there is no attach step or subclass. A **code context** is a durable, named REPL bound to one runtime Worker by the **name of a Service Binding** in your own environment; running code in the same context lets top-level variables, functions, classes, and imported modules from one execution stay visible to the next. There is no `language` option anywhere: the binding determines the language. See [Code contexts](/concepts/code-contexts) for how this works under the hood, and [Use code contexts](/stateful/code-contexts) for a task-oriented walkthrough.

Code contexts are supported for **JavaScript, Python, and Perl**. **Ruby does not support code contexts** — `GET /interpreter` on a Ruby runtime Worker always reports `contexts: false`, the same as any runtime Worker deployed with `--stateless`. Against such a binding, `createCodeContext()` fails with `ValidationFailedError`, and `runCode(code, { binding })` (no `context`) falls back to running statelessly instead.

## Methods

### `createCodeContext()`

Create a new code context.

```ts
await sandbox.interpreter.createCodeContext(options: CreateContextOptions): Promise<CodeContext>
```

**Parameters** (`CreateContextOptions`):

- `binding` — required. The name of a Service Binding, in your own environment, to a sandbox-workers runtime Worker. Must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, name a binding that exists and has a `fetch` method, and answer `GET /interpreter` with `{ language, engine, contexts: true }` — otherwise this throws `ValidationFailedError` ("Unknown binding 'X'", "Binding 'X' is not a sandbox-workers runtime Worker", or "Code contexts are not supported by binding 'X' (language)"). This probe runs only on `createCodeContext` and default-context creation, never on every execution. Typed as `ServiceBindingName<Env>` (see [Types](#types)) when `sandbox` came from [`getSandbox<Env>()`](/api/lifecycle#getsandbox), otherwise plain `string`.
- `cwd` — the context's initial working directory. Defaults to `/workspace`.
- `envVars` — environment variables layered onto executions in this context (`Record<string, string | undefined>`; a value of `undefined` is dropped, not sent).

**Returns**: `Promise<CodeContext>` — see [Types](#types).

```ts
const ctx = await sandbox.interpreter.createCodeContext({
  binding: "PYTHON",
  cwd: "/workspace/project",
  envVars: { API_KEY: env.API_KEY },
});
```

A sandbox holds at most 8 code contexts across all bindings, with one interpreter resident in memory per runtime Worker; the rest are restored from their stored snapshot on next use.

### `listCodeContexts()`

List every code context currently in the sandbox, across every binding.

```ts
await sandbox.interpreter.listCodeContexts(): Promise<CodeContext[]>
```

**Parameters**: none.

**Returns**: `Promise<CodeContext[]>`.

```ts
const contexts = await sandbox.interpreter.listCodeContexts();
```

### `deleteCodeContext()`

Delete a code context: its live interpreter and its stored memory snapshot on that binding's runtime Worker. `/workspace` is untouched, since it belongs to the sandbox, not the context.

```ts
await sandbox.interpreter.deleteCodeContext(id: string): Promise<void>
```

**Parameters**:

- `id` — the context's id, from `CodeContext.id`.

**Returns**: `Promise<void>`.

```ts
await sandbox.interpreter.deleteCodeContext(ctx.id);
```

Deleting an unknown id fails with `ContextNotFoundError`. This is also the way to compact a context whose memory has grown: delete it and create a new one, since a context's linear memory never shrinks on its own. See [Memory snapshots](/concepts/code-contexts#memory-snapshots).

### `runCode()`

Execute code, in a context or statelessly.

```ts
await sandbox.interpreter.runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>
```

**Parameters**:

- `code` — the script to run. The value of its last top-level expression is the result. Limited to 64 KiB UTF-8.
- `options` (optional, `RunCodeOptions`):
  - `context` — the `CodeContext` to run in (from `createCodeContext()` or `listCodeContexts()`).
  - `binding` — the Service Binding name to use when `context` is omitted: runs in (or creates) the **default context** for that binding — the oldest existing context with that `binding`, or a fresh one at `cwd: "/workspace"` when none exists. For a binding that reports `contexts: false` (a stateless-only runtime Worker), this runs **statelessly** through the runtime's plain `POST /execute` instead — no context, no `/workspace`, and the result has no `context` field. Typed as `ServiceBindingName<Env>` (see [Types](#types)) when `sandbox` came from [`getSandbox<Env>()`](/api/lifecycle#getsandbox), otherwise plain `string`.
  - Passing neither `context` nor `binding` fails with `ValidationFailedError` ("Pass a context or a binding").
  - `envVars` — environment variables for this call (`Record<string, string | undefined>`; `undefined` unsets a key for this call rather than being sent).
  - `timeout` — a request timeout in milliseconds; internally builds `AbortSignal.timeout(timeout)`. The guest is still separately bounded by its fuel budget regardless of `timeout`.
  - `signal` — an `AbortSignal` to cancel the request; combined with a `timeout`-derived signal (via `AbortSignal.any`) when both are given.
  - `onStdout` — `(output: { text: string; timestamp: number }) => void | Promise<void>`, called once per stdout line.
  - `onStderr` — same shape as `onStdout`, for stderr.
  - `onResult` — `(result: { text?: string; json?: JsonValue; formats(): string[] }) => void | Promise<void>`, called once per entry in `results` (at most one).
  - `onError` — `(error: ExecutionError) => void | Promise<void>`, called when the execution produced a guest `error`.

**Returns**: `Promise<ExecutionResult>` — see [Types](#types).

`onStdout`/`onStderr`/`onResult`/`onError` all fire **after** the response has arrived, in order (stdout lines, then stderr lines, then result entries, then the error callback) — there is no streaming during execution, and no `runCodeStream`.

`runCode` always resolves, whether or not the guest code raised an error — check `result.error`, described below. It only *throws* for a binding failure or a non-200 response, as a `SandboxError` subclass; see [Errors](/api/errors).

```ts
const ctx = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });

await sandbox.interpreter.runCode("radius = 5", { context: ctx });
const result = await sandbox.interpreter.runCode("import math\nmath.pi * radius ** 2", {
  context: ctx,
});

console.log(result.results[0]); // { text: "78.53981633974483" }
```

### `runCode()` (free function, stateless mode)

Run code statelessly against a runtime Worker, without a sandbox or a code context: a fresh Wasm instance per call, no files, no `getSandbox` involved.

```ts
import { runCode } from "@sandbox-workers/core";

await runCode(target: ServiceBindingTarget | SandboxNamespace, code: string, options?: StatelessRunCodeOptions): Promise<ExecutionResult>
```

**Parameters**:

- `target` — must be a Service Binding (`Fetcher`) to the runtime Worker. Passing a `Sandbox` Durable Object namespace throws synchronously (a plain `Error`, not a rejected promise): use `getSandbox(namespace, id).interpreter.runCode()` for that instead, since there is no sandbox id to route through here.
- `code` — same as `sandbox.interpreter.runCode()`'s `code`.
- `options` (optional): `StatelessRunCodeOptions`, i.e. `RunCodeOptions` minus `context`/`binding` — `envVars`, `timeout`, `signal`, `onStdout`, `onStderr`, `onResult`, `onError`. There is no `context` or `binding` option; a stateless call has no code context and no sandbox to route a binding name through.

**Returns**: `Promise<ExecutionResult>` — see [Types](#types). Guest errors set `result.error` rather than throwing, exactly like `sandbox.interpreter.runCode()`; the callbacks fire in the same order, after the response arrives.

```ts
import { runCode } from "@sandbox-workers/core";

const result = await runCode(env.PYTHON, "import os\nint(os.environ['X']) ** 2", {
  envVars: { X: "12" },
});
```

This is the stateless counterpart above: it posts directly to the runtime Worker's `POST /execute` (see [HTTP API](/api/http-api)), so there is no sandbox id, no context, and no persistence between calls.

### `sandbox.setEnvVars()`

Layer environment variables onto the sandbox, visible to every context regardless of binding. This lives on `sandbox` itself, not on `sandbox.interpreter`.

```ts
await sandbox.setEnvVars(envVars: Record<string, string | undefined>): Promise<void>
```

**Parameters**:

- `envVars` — keys to set or unset. A value of `undefined` unsets that key (sent to the sandbox as `null`); any other value sets it.

**Returns**: `Promise<void>`.

```ts
await sandbox.setEnvVars({ NAME: "value", OLD: undefined }); // unsets OLD
```

See [Environment variables](/configuration/environment-variables) for how sandbox-level, `setEnvVars()`, and per-call `envVars` layer together.

## Types

### `CodeContext`

```ts
interface CodeContext {
  readonly id: string;
  readonly binding: string;
  readonly language: string;
  readonly cwd: string;
  readonly createdAt: Date;
  readonly lastUsed: Date;
}
```

`binding` is the Service Binding name the context was created against; `language` is that binding's runtime language, reported by `GET /interpreter`. `binding` here is always plain `string` — it comes back from the Durable Object, not from your own `Env`.

### `ServiceBindingName<Env>`

```ts
type ServiceBindingName<Env> = {
  [K in keyof Env & string]: Env[K] extends ServiceBindingTarget ? K : never;
}[keyof Env & string];
```

The names of the Service Bindings (values with a `fetch` method) in an `Env` type; this is what `binding` options are narrowed to when `sandbox` came from [`getSandbox<Env>()`](/api/lifecycle#getsandbox).

### `ExecutionResult`

The value every `runCode()` call resolves to:

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

```ts
interface ExecutionResult {
  code: string;
  language: string;
  engine: string;
  durationMs: number;
  logs: { stdout: string[]; stderr: string[] };
  results: Array<{ text?: string; json?: JsonValue }>;
  error?: { name: string; message: string; traceback: string[]; lineNumber?: number };
  executionCount?: number;
  usage?: { fuelConsumed: number; fuelLimit: number; memoryBytes: number };
  context?: { id: string; cwd: string; executions: number; snapshotMs?: number; expiresAt?: number };
}
```

- `language`/`engine` are always the runtime Worker's own (e.g. `"javascript"`) — there is no per-request language selection.
- `durationMs` is elapsed engine execution time, not a billing measurement. `usage` is absent when the engine failed before metering was available.
- `error` is present only for a guest-side failure — a raised exception, or a fuel/output/result limit. It is never thrown; check `result.error` instead. `traceback` is the language's own stack trace, as lines of text.
- `context` is present only when the execution ran in a code context (a stateless call, including one that fell back from a `contexts: false` binding, omits it). `snapshotMs` is present only on an execution that actually wrote a memory snapshot. `expiresAt` reflects the sandbox's idle-expiry deadline as of this request, and is omitted when expiry is disabled.

A guest error looks like this instead — logs produced before the error are still returned, and `results` is empty:

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

#### Result mapping

`results` has at most one entry, chosen from the value of the last top-level expression:

| Value | Entry |
| --- | --- |
| JS `undefined`, Python `None`, Ruby `nil`, Perl `undef` | none — `results` is `[]` |
| Container (JS object/array, Python dict/list, Ruby Hash/Array, Perl HASH/ARRAY ref) | `{ "json": ... }` |
| Anything else | `{ "text": "..." }`, the language's native string representation |

If a container fails to serialize as JSON, it falls back to a `text` entry using the same native representation.

#### Limits

Code is limited to 64 KiB UTF-8; the complete request (code plus `envVars`) is limited to 96 KiB. Fuel, console-output, and result-size limits are reported as a normal (HTTP 200) result with `error.name` set to `"ExecutionLimitError"`, rather than by throwing — console output produced before the limit was hit is still returned in `logs`. See [Limits](/platform/limits) for the exact fuel and output caps per language.
