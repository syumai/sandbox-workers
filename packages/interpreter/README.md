# @sandbox-workers/interpreter

Build your own [sandbox-workers](https://github.com/syumai/sandbox-workers) runtime Worker: the Durable Object and Worker entrypoint base classes that every language runtime (`@sandbox-workers/javascript`, `python`, `perl`, `ruby`) is built on, and that this repo publishes so a third party can build one too.

A runtime Worker speaks a small wire protocol to the caller-hosted `Sandbox` Durable Object (`@sandbox-workers/core`): `GET /interpreter` (capability probe), `POST /execute` (stateless execution), and, for engines that support durable code contexts, `/interpreters/:key/*` plus an `executeInContext` RPC method backed by an `Interpreter` Durable Object. This package implements all of that. You implement an `Engine`: your language's Wasm module (or whatever else runs code), its resource limits, and -- optionally -- how to boot/restore a durable session.

## Quick start

```ts
// src/index.ts
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";

const engine: Engine = {
  language: "calc",
  engineName: "calc 1.0",
  build: "calc-1.0", // identifies this build; a snapshot from a different build boots fresh instead of restoring
  limits: { fuel: 0, memoryBytes: 0, codeBytes: 65536, requestBytes: 98304 },
  run(payload) {
    const value = evaluate(payload.code, payload.envVars ?? {});
    return { logs: { stdout: [], stderr: [] }, results: [{ text: String(value) }] };
  },
  // Omit `sessions` for a stateless-only engine (see "Code contexts" below).
};

const { Worker, Interpreter } = defineInterpreterRuntime(engine);
export { Interpreter };
export default Worker;
```

```jsonc
// wrangler.jsonc
{ "name": "sandbox-calc", "main": "src/index.ts", "compatibility_date": "2026-09-04", "workers_dev": false }
```

Deploy it, then bind it as a Service Binding from your caller Worker and call it through `@sandbox-workers/core`'s `getSandbox(...).runCode(...)` or `createCodeContext({ binding: ... })`.

## The `Engine` contract

- `language`, `engineName`, `build`: identify the runtime. `build` should change whenever the engine itself changes (e.g. a Wasm module's sha256) -- it gates whether a stored code-context snapshot can be restored or must boot fresh.
- `limits`: `{ fuel, memoryBytes, codeBytes, requestBytes }`.
- `run(payload)`: stateless execution (`POST /execute`). May throw `ExecutionLimitError` (re-exported from this package) for a resource limit; any other throw becomes a generic `EngineError`. Never throw for an ordinary guest-level error -- return it as `outcome.error` instead.
- `sessions` (optional): `{ boot(options), restore(options, snapshot) }`, each returning a `SessionInstance`. Omit this entirely for a stateless-only engine: `GET /interpreter` reports `contexts: false`, and every `/interpreters/*` route (and the `executeInContext` RPC method) answers 400 -- this is what `@sandbox-workers/ruby` does today.

### `SessionInstance.execute` never throws for a guest error or a limit

This is the one rule that's easy to get wrong porting an existing interpreter: `execute()` must catch a guest-level exception *and* a resource-limit hit internally and return them as `outcome.error` (with `name: "ExecutionLimitError"` for a limit). Throwing out of `execute()` is reserved for genuine host bugs -- `InterpreterServer` treats any such throw as a trap: it drops the resident instance (no snapshot for that round) and reports a generic `EngineError`.

When a call does invalidate the instance (a trap, or the fuel hard-backstop), set the `invalid` flag rather than throwing; `InterpreterServer` checks only that flag to decide whether to drop the resident instance for the *next* call. A round whose outcome is `ExecutionLimitError` is never snapshotted, even if the instance is still valid (matching how a JS engine's soft interrupt behaves: the instance survives, but that round's memory image is not worth persisting).

`SessionOutcome` also carries `cwd` (the session's current working directory after the call) -- `InterpreterServer` uses it to update the code context's `cwd`, replacing what older, pre-1.0 embedded engines used to return as `session: { cwd }`.

## Code contexts

To support durable code contexts, add the `sessions` field to your `Engine` and export the `Interpreter` class `defineInterpreterRuntime` returns. Bind it in the *caller's* wrangler config as a Durable Object, with the class name and binding name unchanged:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "INTERPRETER", "class_name": "Interpreter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Interpreter"] }]
}
```

`INTERPRETER_IDLE_TTL_MS` (a string env var on the runtime Worker) controls how long an idle `Interpreter` Durable Object stays resident before wiping itself; unset defaults to 24 hours, `"0"` disables expiry. This should be at least as large as the caller-side `Sandbox`'s own `SANDBOX_IDLE_TTL_MS`.

`snapshot()`/`restore()` are built around a `WebAssembly.Memory`: code contexts assume a Wasm engine. A non-Wasm engine can still ship (as a stateless-only runtime, no `sessions`) but durable sessions are not supported for it today.

## Subpath exports

- `.` -- everything above.
- `./snapshot` -- the linear-memory snapshot/chunk helpers `InterpreterServer` uses internally. Unstable: documented for an `Engine` author's own session boot/restore code, not a versioned public contract.
- `./testing` -- `createTestState()`, a fake `DurableObjectStateLike` backed by `node:sqlite`, for driving an `InterpreterServer` from a Node test without a Workers runtime. Node-only.

## Stability

This package is 0.x: the `Engine`/`SessionInstance` contract can still change in a minor release. The wire protocol itself (routes, headers, RPC signatures, the Durable Object storage format) is stable and versioned separately via `GET /interpreter`'s `protocol` field.
