# @sandbox-workers/interpreter

Build your own [sandbox-workers](https://github.com/syumai/sandbox-workers) runtime Worker: the Durable Object and Worker entrypoint base classes that every language runtime (`@sandbox-workers/javascript`, `python`, `perl`, `ruby`) is built on, and that this repo publishes so a third party can build one too.

A caller Worker (your app, using **`@sandbox-workers/core`**) talks to a runtime Worker over a small wire protocol -- `GET /interpreter` (capability probe), `POST /execute` (stateless execution) and, for engines that support durable code contexts, `/interpreters/:key/*` plus an `executeInContext` RPC method backed by an `Interpreter` Durable Object -- tagged with a `protocol` version (currently `1`) so old and new runtime Workers stay interoperable. This package implements the **runtime side** of that protocol; `@sandbox-workers/core` implements the caller side. You implement an `Engine`: your language's Wasm module (or whatever else runs code), its resource limits, and -- optionally -- how to boot/restore a durable session.

## Quick start

A stateless-only runtime needs no Wasm at all. Here's a complete one for a tiny arithmetic language, `calc`:

```ts
// src/index.ts
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { evaluate } from "./calc.js"; // your own arithmetic evaluator

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

// No `sessions` on `engine`, so no `Interpreter` export either -- a
// stateless-only runtime has no Durable Object to bind (matching this
// repo's own Ruby runtime). See "Code contexts" below for a runtime that
// does support durable sessions.
export default defineInterpreterRuntime(engine).Worker;
```

```jsonc
// wrangler.jsonc
{ "name": "sandbox-calc", "main": "src/index.ts", "compatibility_date": "2026-09-04", "workers_dev": false }
```

Deploy it (`wrangler deploy`), then bind it as a Service Binding from your caller Worker:

```jsonc
// your caller's wrangler.jsonc
{ "services": [{ "binding": "CALC", "service": "sandbox-calc" }] }
```

```ts
// your caller Worker, using @sandbox-workers/core
import { runCode } from "@sandbox-workers/core";

const result = await runCode(env.CALC, "1 + 2 * 3"); // { results: [{ text: "7" }], ... }
```

If your caller already hosts a `Sandbox` Durable Object (`getSandbox(env.Sandbox, id)`), the same binding works through `sandbox.interpreter.runCode(code, { binding: "CALC" })` too -- since this engine has no `sessions`, `GET /interpreter` reports `contexts: false`, and `sandbox.interpreter` automatically falls back to the same stateless `/execute` path `runCode` uses (`createCodeContext({ binding: "CALC" })` fails for it, same as it does for this repo's own Ruby runtime).

## The `Engine` contract

- `language`, `engineName`, `build`: identify the runtime. `build` should change whenever the engine itself changes in a way that would make an old snapshot unsafe to restore -- this repo's four packages use the sha256 of their `engine.wasm` (see each `worker.ts`'s `build.sha256`, from a checked-in `engine-build.json`). A stored snapshot whose `build` doesn't match the engine's current `build` boots fresh instead of restoring, which is what makes an engine upgrade safe against a stale on-disk snapshot.
- `limits`: `{ fuel, memoryBytes, codeBytes, requestBytes }`.
- `run(payload)`: stateless execution (`POST /execute`). May throw `ExecutionLimitError` (re-exported from this package) for a resource limit; any other throw becomes a generic `EngineError`. Never throw for an ordinary guest-level error -- return it as `outcome.error` instead.
- `sessions` (optional): `{ boot(options), restore(options, snapshot) }`, each returning a `SessionInstance`. Omit this entirely for a stateless-only engine: `GET /interpreter` reports `contexts: false`, and every `/interpreters/*` route (and the `executeInContext` RPC method) answers 400 -- this is what `@sandbox-workers/ruby` does today.

### What `InterpreterServer` enforces

`InterpreterServer` -- the base every `Interpreter` Durable Object delegates to -- normalizes the session contract with a small, fixed set of rules, so an `Engine` implementation never needs to reimplement bookkeeping around traps, limits, or stale snapshots:

- **`SessionInstance.execute()` never throws for a guest error or a resource limit.** Both come back as `outcome.error` (`name: "ExecutionLimitError"` for a limit). Throwing out of `execute()` is reserved for genuine host bugs; `InterpreterServer` treats any such throw as a trap -- it drops the resident instance (no snapshot for that round) and reports a generic `EngineError`.
- **`instance.invalid` drops the resident instance.** Set it when a call invalidates the instance (a trap, or the fuel hard-backstop) instead of throwing; `InterpreterServer` checks only this flag -- never a thrown error -- to decide whether to boot fresh on the *next* call.
- **An `ExecutionLimitError`-named outcome is never snapshotted that round**, even if the instance is still valid (matching how a JS engine's soft interrupt behaves: the instance survives, but that round's memory image is not worth persisting).
- **`canSnapshot()` returning `false` marks the stored snapshot record stale**, not gone: `InterpreterServer` still calls `snapshot()` only when `canSnapshot()` is `true` (typically false while the guest holds an open file descriptor beyond its preopens), but the *previous* on-disk snapshot keeps describing a genuinely valid prior state -- the response's `context.snapshot.stale` just flags that it's now behind what's in memory.
- **`SessionOutcome.cwd` feeds the context's `cwd`.** `InterpreterServer` reads it after every call to update the code context's `cwd`, replacing what older, pre-1.0 embedded engines used to return as `session: { cwd }`.
- **`snapshot()` returns a real `WebAssembly.Memory`.** Code contexts are built entirely around linear-memory snapshots, so `sessions` requires a Wasm engine; a non-Wasm runtime (e.g. a hand-rolled DSL evaluator with no `WebAssembly.Memory` at all) can still ship as a stateless-only engine, but durable sessions are not supported for it today (see "Not in scope" in the design doc's risk list).

## Code contexts

To support durable code contexts, add the `sessions` field to your `Engine` and export the `Interpreter` class `defineInterpreterRuntime` returns. Bind it in the *caller's* wrangler config as a Durable Object, with the class name and binding name unchanged:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "INTERPRETER", "class_name": "Interpreter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Interpreter"] }]
}
```

`INTERPRETER_IDLE_TTL_MS` (a string env var on the runtime Worker) controls how long an idle `Interpreter` Durable Object stays resident before wiping itself; unset defaults to 24 hours, `"0"` disables expiry. This should be at least as large as the caller-side `Sandbox`'s own `SANDBOX_IDLE_TTL_MS`, or a context's state can be gone while the sandbox still lists it.

## Wasm-based engines

Building a WASI-hosted Wasm engine (this repo's `@sandbox-workers/javascript`, `python`, `perl`, `ruby` all are) reuses two subpaths instead of reimplementing WASI wiring or a snapshot-replay recipe from scratch:

- **`./wasi`** -- `createWasi(module, archive, meter, envVars, workspaceDir, options)` builds the WASI host: stdio capture with the sandbox's output limits, the read-only `/stdlib` archive mount, an optional `/workspace` mount gated by `Workspace.disabled`, and a `sandbox.tick` import wired to a fuel meter. The archive/`/workspace`/preopen mounts are wired in a **fixed order** (stdlib, then workspace) so a restored instance's guest-visible file descriptor numbers stay stable across a boot/restore cycle -- an engine driver must not open its own extra preopens ahead of these. Also exports `budget(fuel)` (a simple fuel meter), `hasOpenGuestFds(host)` (the snapshot precondition: false while the guest holds an open file descriptor beyond the fixed preopens), and re-exports `ExecutionLimitError`.
- **`./wasmify`** -- the protobuf-ish ABI (`message`, `invoke`) goccy's spidermonkey-wasm-family Python and Perl builds expose, and a language-neutral embedded-interpreter session host built on it: `runWasmify` (stateless), `bootWasmifySession`/`restoreWasmifySession` (sessions). A language plugs in its language-specific parts as a `WasmifyDriver`: `initMethod` (the wasmify method id that creates the interpreter handle), `sessionBoot` (a script run once when a session boots), `evaluate` (runs one script, capturing stdout/stderr, returning a string result), `sessionExecute` (one session call, returning `{ results, error?, cwd? }`), `runOnce` (one stateless call), and an optional `afterRestore` hook (e.g. Python's driver re-seeds `random` after a restore). See `packages/python/src/engine.mjs` for a complete, worked `WasmifyDriver` (`packages/perl/src/engine.mjs` is the other). A non-embedded Wasm engine -- `@sandbox-workers/javascript`, whose SpiderMonkey build talks to the host through its own host-function bridge instead of `wasmify` -- uses only `./wasi`.

Both subpaths take resource limits as plain arguments (a `fuel` number) rather than reading them from anywhere global -- pass `pythonRuntime.limits.fuel` (from `./metadata`), not a hard-coded constant.

## Testing

`./testing` (Node-only -- it imports `node:sqlite`, so it is a separate subpath from `.`, never bundled into a Worker) gives you two things:

- **`createTestState(options?)`** -- a fake `DurableObjectStateLike` backed by a `node:sqlite` `DatabaseSync`, so you can drive a real `InterpreterServer` from a plain Node test with no Workers runtime. Pass the same `db` to two calls to simulate a Durable Object being evicted and recreated over the same storage.
- **`runEngineConformance(engine, options)`** -- an async conformance suite that drives a real `InterpreterServer` over `createTestState()` against your `Engine` and throws (`node:assert/strict`) on the first contract violation: stateless `run()` on a trivial program, `language`/`engineName`/`build`/`limits` sanity, and -- when `engine.sessions` is set -- a code context's state surviving both a normal `execute()` round-trip *and* a simulated eviction/restore from the persisted snapshot, a guest error rolling the workspace mirror back, context deletion, and `DELETE /` wiping everything. This repo's own four language packages run it too (`tests/conformance.test.mjs`), so a third-party engine is checked against the exact same contract.

```ts
// your-engine.test.ts (or .mjs, run with node --test)
import { runEngineConformance } from "@sandbox-workers/interpreter/testing";
import { engine } from "./index.js"; // the Engine you built above

await runEngineConformance(engine, {
  programs: {
    simple: { code: "1 + 1", expectResultText: "2" },
    error: { code: "1 / 0" }, // any guest-level error; only outcome.error is checked
    // Omit `stateful` for a stateless-only engine (no `sessions`).
    stateful: { define: "x = 1", use: "x + 1", expectResultText: "2" },
  },
});
```

`runEngineConformance` doesn't know your language, so you supply the minimal programs above; everything else -- the Durable Object storage, the workspace mirror, snapshot restore -- is exercised by the suite itself.

## Extending `InterpreterWorker`/`InterpreterDurableObject` directly

`defineInterpreterRuntime(engine)` is the entry point almost every runtime should use. Extending `InterpreterWorker`/`InterpreterDurableObject` directly is for the rarer case of adding your own methods or routes to the Worker entrypoint or the Durable Object:

```ts
class MyInterpreter extends InterpreterDurableObject {
  protected readonly engine = engine; // a field initializer, not read in a constructor -- see below
}
class MyWorker extends InterpreterWorker {
  protected readonly engine = engine;
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");
    return super.fetch(request);
  }
}
```

One caveat: `InterpreterDurableObject`'s constructor builds its internal `InterpreterServer` (and runs the Durable Object's own schema setup via `blockConcurrencyWhile`) before a subclass's field initializers have run. Don't read `this.engine` from a constructor you add -- `InterpreterServer` itself only reads it lazily, on the first `fetch`/`executeInContext`/`alarm` call, which is why the class-field pattern above (not a constructor assignment) is required.

## Subpath exports

- `.` -- `InterpreterWorker`, `InterpreterDurableObject`, `defineInterpreterRuntime`, the `Engine`/`SessionInstance` types, and selective re-exports from `@sandbox-workers/core` (`ExecutionLimitError`, `Workspace`, the wire-protocol types) so most `Engine` implementations never need to depend on core directly.
- `./snapshot` -- the linear-memory snapshot/chunk helpers `InterpreterServer` uses internally. Unstable: documented for an `Engine` author's own session boot/restore code, not a versioned public contract.
- `./wasi`, `./wasmify` -- see "Wasm-based engines" above.
- `./testing` -- see "Testing" above. Node-only.

## Stability

This package is 0.x: the `Engine`/`SessionInstance` contract can still change in a minor release while the package is pre-1.0. The wire protocol itself (routes, headers, RPC signatures, the Durable Object storage format) is stable and versioned separately, via `GET /interpreter`'s `protocol` field (currently `1`) -- a caller and a runtime Worker built against different `@sandbox-workers/interpreter`/`@sandbox-workers/core` versions still interoperate as long as they speak the same `protocol` number.
