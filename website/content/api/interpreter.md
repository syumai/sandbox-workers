---
title: Code interpreter
description: Create code contexts and run code with the typed client.
---

Code contexts are durable, named REPLs inside a sandbox. Running code in the same context lets top-level variables, functions, classes, and imported modules from one execution stay visible to the next; running without a context is stateless. See [Code contexts](/concepts/code-contexts) for how this works under the hood, and [Use code contexts](/guides/code-contexts) for a task-oriented walkthrough.

Code contexts are supported for **JavaScript, Python, and Perl**. **Ruby does not support code contexts** — a context-less `runCode()` still works and runs statelessly (a fresh Wasm instance every call), but `createCodeContext()`, `listCodeContexts()`, and `deleteCodeContext()` are not available on a Ruby runtime Worker.

## Methods

### `createCodeContext()`

Create a new code context.

```ts
await sandbox.createCodeContext(options?: CreateContextOptions): Promise<CodeContext>
```

**Parameters**:

- `options` (optional):
  - `language` — the context's language. Aliases are accepted case-insensitively and normalized: `python3` → `python`, `js`/`node` → `javascript`, `ts` → `typescript`. The context's `language` is stored and reported as this normalized value — a `typescript` context is distinct from a `javascript` one, even though both execute on the JavaScript runtime.
  - `cwd` — the context's initial working directory.
  - `envVars` — environment variables layered onto executions in this context (`Record<string, string | undefined>`; a value of `undefined` is dropped, not sent).

**Returns**: `Promise<CodeContext>` — see [Types](#types).

```ts
const ctx = await sandbox.createCodeContext({
  language: "python",
  cwd: "/workspace/project",
  envVars: { API_KEY: env.API_KEY },
});
```

A sandbox holds at most 8 code contexts at a time, with one interpreter resident in memory; the rest are restored from their stored snapshot on next use.

### `listCodeContexts()`

List every code context currently in the sandbox.

```ts
await sandbox.listCodeContexts(): Promise<CodeContext[]>
```

**Parameters**: none.

**Returns**: `Promise<CodeContext[]>`.

```ts
const contexts = await sandbox.listCodeContexts();
```

### `deleteCodeContext()`

Delete a code context: its live interpreter and its stored memory snapshot. `/workspace` is untouched, since it belongs to the sandbox, not the context.

```ts
await sandbox.deleteCodeContext(id: string): Promise<void>
```

**Parameters**:

- `id` — the context's id, from `CodeContext.id`.

**Returns**: `Promise<void>`.

```ts
await sandbox.deleteCodeContext(ctx.id);
```

This is also the way to compact a context whose memory has grown: delete it and create a new one, since a context's linear memory never shrinks on its own. See [Memory snapshots](/concepts/code-contexts#memory-snapshots).

### `runCode()`

Execute code, in a context or statelessly.

```ts
await sandbox.runCode(code: string, options?: RunCodeOptions): Promise<ExecutionResult>
```

**Parameters**:

- `code` — the script to run. The value of its last top-level expression is the result. Limited to 64 KiB UTF-8.
- `options` (optional):
  - `context` — the `CodeContext` to run in (from `createCodeContext()` or `listCodeContexts()`). Omit it to run in (or create) the default context for the request's language — the first context of that language, so simple callers never need to think about contexts.
  - `language` — the language to use when no `context` is given (same aliases as `createCodeContext()`'s `language`).
  - `envVars` — environment variables for this call (`Record<string, string | undefined>`; `undefined` unsets a key for this call rather than being sent).
  - `timeout` — a request timeout in milliseconds; internally builds `AbortSignal.timeout(timeout)`. The guest is still separately bounded by its fuel budget regardless of `timeout`.
  - `signal` — an `AbortSignal` to cancel the request; combined with a `timeout`-derived signal (via `AbortSignal.any`) when both are given.
  - `onStdout` — `(output: { text: string; timestamp: number }) => void | Promise<void>`, called once per stdout line.
  - `onStderr` — same shape as `onStdout`, for stderr.
  - `onResult` — `(result: { text?: string; json?: JsonValue; formats(): string[] }) => void | Promise<void>`, called once per entry in `results` (at most one).
  - `onError` — `(error: ExecutionError) => void | Promise<void>`, called when the execution produced a guest `error`.

**Returns**: `Promise<ExecutionResult>` — see [Types](#types).

`onStdout`/`onStderr`/`onResult`/`onError` all fire **after** the response has arrived, in order (stdout lines, then stderr lines, then result entries, then the error callback) — there is no streaming during execution.

`runCode` always resolves, whether or not the guest code raised an error — check `result.error`, described below. It only *throws* for a binding failure or a non-200 response, as a `SandboxError` subclass; see [Errors](/api/errors).

```ts
const ctx = await sandbox.createCodeContext({ language: "python" });

await sandbox.runCode("radius = 5", { context: ctx });
const result = await sandbox.runCode("import math\nmath.pi * radius ** 2", {
  context: ctx,
});

console.log(result.results[0]); // { text: "78.53981633974483" }
```

### `runCode()` (free function)

Run code statelessly against a runtime Worker, without a sandbox or a code context: a fresh Wasm instance per call, no files, no `getSandbox` involved.

```ts
import { runCode } from "@sandbox-workers/core";

await runCode(target: SandboxTarget, code: string, options?: StatelessRunCodeOptions): Promise<ExecutionResult>
```

**Parameters**:

- `target` — must be a Service Binding (`Fetcher`) to the runtime Worker. Passing a Durable Object namespace throws synchronously (a plain `Error`, not a rejected promise): use `getSandbox(namespace, id).runCode()` for that transport instead, since a namespace has no meaning without a sandbox id to route through.
- `code` — same as `sandbox.runCode()`'s `code`.
- `options` (optional): `StatelessRunCodeOptions`, i.e. `RunCodeOptions` minus `context` — `language`, `envVars`, `timeout`, `signal`, `onStdout`, `onStderr`, `onResult`, `onError`. There is no `context` option; a stateless call cannot run in a code context.

**Returns**: `Promise<ExecutionResult>` — see [Types](#types). Guest errors set `result.error` rather than throwing, exactly like `sandbox.runCode()`; the callbacks fire in the same order, after the response arrives.

```ts
const result = await runCode(env.SANDBOX, "import os\nint(os.environ['X']) ** 2", {
  envVars: { X: "12" },
});
```

This is the stateless counterpart to `sandbox.runCode()` above: it posts directly to `POST /execute` (see [HTTP API](/api/http-api)) rather than `POST /sandboxes/:id/execute`, so there is no sandbox id, no context, and no persistence between calls.

### `setEnvVars()`

Layer environment variables onto the sandbox, visible to every context.

```ts
await sandbox.setEnvVars(envVars: Record<string, string | undefined>): Promise<void>
```

**Parameters**:

- `envVars` — keys to set or unset. A value of `undefined` unsets that key (sent to the runtime Worker as `null`); any other value sets it.

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
  readonly language: string;
  readonly cwd: string;
  readonly createdAt: Date;
  readonly lastUsed: Date;
}
```

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

- `language` is always the runtime Worker's own language (e.g. `"javascript"`), even when the execution ran in a `"typescript"` code context — compare `CodeContext.language`, which reports the requested/normalized language.
- `durationMs` is elapsed engine execution time, not a billing measurement. `usage` is absent when the engine failed before metering was available.
- `error` is present only for a guest-side failure — a raised exception, or a fuel/output/result limit. It is never thrown; check `result.error` instead. `traceback` is the language's own stack trace, as lines of text.
- `context` is present only when the execution ran in a code context (Ruby's context-less `runCode()` omits it). `snapshotMs` is present only on an execution that actually wrote a memory snapshot. `expiresAt` reflects the sandbox's idle-expiry deadline as of this request, and is omitted when expiry is disabled.

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
