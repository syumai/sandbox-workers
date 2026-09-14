---
title: Build your own runtime
description: Build a sandbox-workers-compatible runtime Worker for any language with @sandbox-workers/interpreter.
---

Package: [`@sandbox-workers/interpreter`](https://www.npmjs.com/package/@sandbox-workers/interpreter) ([README on GitHub](https://github.com/syumai/sandbox-workers/tree/main/packages/interpreter#readme)). This is the base every runtime Worker in this repository (JavaScript, Python, Perl, Ruby) is built on, published so a third party can build one for another language, or another engine entirely. You implement an `Engine` — your language's Wasm module (or whatever else runs code), resource limits, and, optionally, how to boot/restore a durable session — and this package implements the wire protocol every caller Worker (`@sandbox-workers/core`) speaks: `GET /interpreter`, `POST /execute`, and, for engines that support durable [code contexts](/concepts/code-contexts), `/interpreters/:key/*` plus an `executeInContext` RPC method backed by an `Interpreter` Durable Object.

## Quick start

A stateless-only runtime needs no Wasm at all:

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

export default defineInterpreterRuntime(engine).Worker;
```

```jsonc
// wrangler.jsonc
{ "name": "sandbox-calc", "main": "src/index.ts", "compatibility_date": "2026-09-04", "workers_dev": false }
```

Deploy it, add it as a Service Binding in your caller Worker's `wrangler.jsonc`, and call it with `runCode(env.CALC, code)` (`@sandbox-workers/core`) — or, if your caller already hosts a `Sandbox` Durable Object, `sandbox.interpreter.runCode(code, { binding: "CALC" })`, which falls back to the same stateless path since this engine has no `sessions` (`contexts: false`).

## The `Engine` contract

- `language`, `engineName`, `build`: identify the runtime. `build` should change whenever the engine itself changes in a way that would make an old snapshot unsafe to restore — this repo's four packages use the sha256 of their `engine.wasm`. A stored snapshot whose `build` doesn't match boots fresh instead of restoring.
- `limits`: `{ fuel, memoryBytes, codeBytes, requestBytes }`.
- `run(payload)`: stateless execution. May throw `ExecutionLimitError` (re-exported from the package) for a resource limit; never throw for an ordinary guest-level error — return it as `outcome.error` instead.
- `sessions` (optional): `{ boot(options), restore(options, snapshot) }`. Omit entirely for a stateless-only engine (`contexts: false`, matching `@sandbox-workers/ruby`).

`InterpreterServer`, the base every `Interpreter` Durable Object delegates to, enforces a small, fixed set of rules on top of this: `SessionInstance.execute()` never throws for a guest error or a resource limit (both come back as `outcome.error`); `instance.invalid` — not a thrown error — is what tells the server to drop a resident instance; a round whose outcome is `ExecutionLimitError` is never snapshotted; `canSnapshot()` returning `false` marks the *stored* snapshot stale without discarding it; and `snapshot()` returns a real `WebAssembly.Memory`, since code contexts are built entirely around linear-memory snapshots — a non-Wasm engine can still ship, but only as stateless-only. See the package README for the full contract and the reasoning behind each rule.

## Code contexts

To support durable code contexts, add `sessions` to your `Engine` and export the `Interpreter` class `defineInterpreterRuntime` returns, then bind it in the *caller's* wrangler config with the class name and binding name unchanged:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "INTERPRETER", "class_name": "Interpreter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Interpreter"] }]
}
```

`INTERPRETER_IDLE_TTL_MS` on the runtime Worker controls how long an idle `Interpreter` Durable Object stays resident before wiping itself (default 24 hours, `"0"` disables expiry) — set it to at least the caller's own `SANDBOX_IDLE_TTL_MS`.

## Wasm-based engines

If your engine is Wasm and WASI-hosted (like this repo's own four), two subpaths save you from reimplementing WASI wiring or a snapshot-replay recipe: `@sandbox-workers/interpreter/wasi` (the WASI host, a fuel meter, and the `canSnapshot()` precondition helper) and `@sandbox-workers/interpreter/wasmify` (a language-neutral session host for an embedded interpreter driven through the wasmify protobuf ABI, as `packages/python/src/engine.mjs` and `packages/perl/src/engine.mjs` show). A non-embedded Wasm engine — this repo's `@sandbox-workers/javascript`, whose SpiderMonkey build talks to the host through its own bridge — uses only `./wasi`.

## Testing

`@sandbox-workers/interpreter/testing` exports `runEngineConformance(engine, options)`, an async conformance suite that drives a real `InterpreterServer` against your `Engine` from plain Node (`node:sqlite`, no Workers runtime) and throws on the first contract violation — stateless execution, engine identity/limits, and, when your engine has `sessions`, state surviving a normal round-trip and a simulated Durable Object eviction/restore, a guest error rolling the workspace back, context deletion, and a full wipe. This repository's own four language packages run the exact same suite against their real Wasm engines (`tests/conformance.test.mjs`).

```ts
import { runEngineConformance } from "@sandbox-workers/interpreter/testing";
import { engine } from "./index.js";

await runEngineConformance(engine, {
  programs: {
    simple: { code: "1 + 1", expectResultText: "2" },
    error: { code: "1 / 0" },
    stateful: { define: "x = 1", use: "x + 1", expectResultText: "2" }, // omit if no `sessions`
  },
});
```

## Stability

`@sandbox-workers/interpreter` is 0.x: the `Engine`/`SessionInstance` contract can still change in a minor release. The wire protocol (routes, headers, RPC signatures, storage format) is stable and versioned separately via `GET /interpreter`'s `protocol` field.

## Not yet built

There is no `sandbox-workers init --custom` scaffold generator yet — start from the Quick start example above and the package README.

## Related resources

- [Architecture](/concepts/architecture)
- [Code contexts](/concepts/code-contexts)
- [Runtime engines](/concepts/runtimes)
- [`@sandbox-workers/interpreter` README on GitHub](https://github.com/syumai/sandbox-workers/tree/main/packages/interpreter#readme)
