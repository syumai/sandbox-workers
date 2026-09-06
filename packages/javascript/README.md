# @sandbox-workers/javascript

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript)

Use the source template before npm publication. It creates a private Worker; configure your caller’s Service Binding after deployment. The source repository must be public for the button to work.

A Cloudflare Workers Service Binding runtime containing SpiderMonkey (Firefox 147)
compiled to Wasm via [goccy/spidermonkey-wasm](https://github.com/goccy/spidermonkey-wasm)
v0.2.6. Version 0.1.0 preview; not yet published to npm.

## Quick start

After the first npm release:

```sh
pnpm dlx @sandbox-workers/cli init javascript my-javascript
cd my-javascript
pnpm install
pnpm run dry-run
pnpm run deploy
```

Before publication, install the local tarball produced by the repository's `pnpm run pack`.

The initializer refuses to overwrite existing files. Choose a Worker name in `wrangler.jsonc` that fits your account. Public URLs are disabled.

## Existing Worker project

Use this entrypoint in a dedicated Worker:

```js
export { default } from "@sandbox-workers/javascript";
```

Disable `workers_dev` and `preview_urls`, deploy the runtime, and add a Service Binding to the calling application's configuration:

```json
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }] }
```

The service name must match the deployed Worker. Install `@sandbox-workers/core` in the calling application:

```js
import { getSandbox } from "@sandbox-workers/core";
const sandbox = getSandbox(env.SANDBOX, "user-42");
const result = await sandbox.runCode(
  "const x = Number(process.env.X);\nx ** 2",
  { envVars: { X: "12" } },
);
```

Or use `env.SANDBOX.fetch(new Request('https://sandbox.internal/execute', ...))`
with a JSON POST body `{ "code": "42" }`.
Both Workers must be deployed in your own Cloudflare account. A Service Binding
is to a deployed Worker name; installing this npm package alone does not create it.
For local development run both Wrangler projects, or pass both `-c` configs to
one `wrangler dev` command.

This package also exports the `Sandbox` Durable Object class, so a dedicated
Worker can open durable, stateful **code contexts** (globals persist across
calls) instead of only the stateless `/execute` above:

```js
export { default, Sandbox } from "@sandbox-workers/javascript";
```

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
}
```

```js
const ctx = await sandbox.createCodeContext();
await sandbox.runCode("counter = 1", { context: ctx });
await sandbox.runCode("counter += 1; counter", { context: ctx }); // 2
```

See the [sandboxes and code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/code-contexts.md)
for the full client API, the files API, and per-language REPL semantics.

## Execution contract

`POST /execute` accepts `{code, envVars}`. This runtime Worker always executes JavaScript; the runtime is chosen by the Service Binding, not by the request, and a request that still carries a `language` key is rejected. Code is a **script**: the value of the last top-level expression is the result; a top-level `return` is a guest `SyntaxError`. Data is passed with `envVars` (string values only) and read as `process.env.NAME`. `console.log`/`info`/`debug` calls are captured into `logs.stdout`, `warn`/`error` into `logs.stderr`, with one trailing newline stripped per entry. Results serialize as `{text}` or `{json}`; BigInt values become a string ending in `n`, and an `undefined` result produces an empty `results` array.

Each execution creates a fresh Wasm instance: there is no state shared between requests, and each request evaluates a fresh SpiderMonkey global. Every execution — success, guest error, or a fuel/console/result limit — returns HTTP 200 with `{code, language, engine, durationMs, logs, results, error?, usage?}`; check the `error` field (`error.name` is `ExecutionLimitError` for limits, `EngineError` for engine failures) through the shared client. Only request/transport problems (bad JSON, an `input`/`language` key, wrong method, oversized payload, wrong content type) use non-200 statuses.

This engine has **no Web APIs**: there is no `fetch`, `URL`, `Response`, `TextEncoder`, `structuredClone`, `atob`, timers (`setTimeout`), or `WebAssembly`. A pending promise that never settles (because there is nothing to wait on) is reported as a guest error rather than hanging the request. `Intl` (e.g. `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.Collator`) is available and backed by real ICU data. `SharedArrayBuffer` and `Atomics` are removed before guest code runs.

TypeScript is also accepted automatically: there is no `language` option and
no separate mode. Code is parsed as JavaScript first, so valid JavaScript
never changes meaning (e.g. `a < b > (c)` stays a comparison, never a generic
call); only code that fails to parse as JavaScript falls back to stripping
TypeScript-only syntax (type annotations, `interface`, generics,
`as`/`satisfies`, `enum`, `namespace`, parameter properties) before running.
Types are stripped, not checked, so a type error still runs and returns a
result, like any other JavaScript mistake; a real TypeScript syntax error is
reported as a guest `SyntaxError`. ES-module `import`/`export` remain
unsupported in both dialects.

Every execution creates a fresh Wasm instance; no context persists between
calls. Fuel bounds the interpreter to 50,000,000 ticks via an interrupt
request rather than a trap, so it stays catchable inside the guest; the linear
memory maximum is 64 MiB, with a 32 MiB heap cap enforced by the engine itself.
Code is limited to 64 KiB, request to 96 KiB and the serialized result to
64 KiB. Console capture is bounded to 200 entries / 32,768 UTF-16 code units
combined across `stdout`/`stderr`. CPU/isolate overhead and concurrent memory
use still need to fit Cloudflare's separate resource limits.

This is an experimental runtime, not a claim of full Test262 conformance or a
production security audit. The demo is independent of your deployment.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the embedded runtime licenses and source references.
