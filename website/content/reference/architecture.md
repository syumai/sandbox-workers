---
title: Architecture
description: How the JavaScript engine and multi-runtime gateway fit together.
---

Submit arbitrary JavaScript to `POST /execute` and execute it inside **SpiderMonkey compiled to Wasm** via [goccy/spidermonkey-wasm](https://github.com/goccy/spidermonkey-wasm). The sandbox-workers Playground provides a CodeMirror editor, an env vars pane, console/result/raw JSON tabs, execution metrics, and examples.

## Architecture

```text
Browser / API client
        │ POST /execute/<language> { code, envVars }
        ▼
sandbox-workers                     src/index.ts
  ├── Static Assets / CodeMirror   ui/
  └── URL path → Service Binding
        │ JAVASCRIPT
        ▼
sandbox-engine-javascript          engine/index.ts (public URLs disabled)
  └── Host-side transform + ABI    runtime/javascript.mjs, packages/javascript/src/transform.mjs
        └── Fresh Wasm instance per request
              └── SpiderMonkey + runtime/javascript-prelude.mjs
```

The runtime embeds a prebuilt SpiderMonkey (Firefox 147) Wasm module from `goccy/spidermonkey-wasm` v0.2.6, fuel-instrumented at build time by `scripts/instrument.mjs`, and talks to it through the same wasmify protobuf ABI used by the Python and Perl engines (`runtime/protobuf.mjs`). `runtime/javascript.mjs` transforms the submitted code on the host into an async IIFE with `transformForAsyncExecution` (acorn-based, `packages/javascript/src/transform.mjs`), creates a fresh JS runtime handle (`js_new`) with a 32 MiB heap cap and a 1 MiB native stack quota, evaluates a small prelude (`runtime/javascript-prelude.mjs`) that installs `console` and a `__sandbox` helper, then evaluates the transformed IIFE text with `js_eval`. There is no Wizer snapshot step and no persistent guest state between requests: every call boots a fresh Wasm instance.

The host denies every Wasm import it does not explicitly implement (randomness, clocks, and the fuel/interrupt hooks used for metering); unimplemented WASI calls and the never-used `thread-spawn`/`go_host_call` bridges are stubbed out. `SharedArrayBuffer` and `Atomics` are deleted from the guest's `globalThis` before any code runs, even though the engine's linear memory is declared shared (for a thread-spawn path this sandbox never enables).

## Run locally

Requires Node.js 22.12 or later (tested with 24.18) and npm.

```sh
pnpm add --frozen-lockfile
pnpm run dev
```

Open [localhost:8787](http://localhost:8787). The command builds the engines, packages, and UI, then starts the gateway and four runtime Workers. The first build can take several minutes (`build:languages` fetches and fuel-instruments all four engine Wasm modules). After UI changes, run `pnpm run build:ui` in another terminal. Engine or transform changes require `pnpm run build:languages` and `pnpm run build:packages`.

The editor supports completion, syntax highlighting, line numbers, folding, bracket matching, search, and undo/redo. Cmd/Ctrl+Enter runs the code. Draft code and env vars are saved in local storage.

```sh
curl http://localhost:8787/execute \
  -H 'Content-Type: application/json' \
  --data '{"code":"console.log(process.env.X);\nawait Promise.resolve(Number(process.env.X) ** 2);","envVars":{"X":"12"}}'
```

```json
{
  "code": "console.log(process.env.X);\nawait Promise.resolve(Number(process.env.X) ** 2);",
  "language": "javascript",
  "engine": "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6",
  "durationMs": 8,
  "logs": { "stdout": ["12"], "stderr": [] },
  "results": [{ "text": "144" }],
  "usage": {
    "fuelConsumed": 1800000,
    "fuelLimit": 50000000,
    "memoryBytes": 34668544
  }
}
```

Metric values above are illustrative. Code is a **script**: the value of the last top-level expression is the result (`await` also works, but a top-level `return` is not supported and surfaces as a guest `SyntaxError`). Data is passed with `envVars` and read as `process.env.NAME`; nothing from the host environment leaks in. An `undefined` result produces an empty `results` array. Containers (objects/arrays) are returned as `{ json }`; everything else is returned as `{ text }` using a `util.inspect`-like representation (strings single-quoted, BigInt values rendered as `123n`). Circular references in a JSON-serialized result fail. ES module `import`/`export`, npm resolution, and a Node.js environment are not provided; there are no Web builtins (no `fetch`, `URL`, `Response`, `TextEncoder`, timers), but `Intl` is available and backed by real ICU data.

`GET /languages` lists supported languages, execution modes, capabilities, and limits.

| JavaScript response                                                   | HTTP status         |
| ---------------------------------------------------------------------- | ------------------- |
| Success, guest error, or a fuel/output/result limit exceeded           | 200; check `error`  |
| Invalid JSON, unsupported `/execute/<language>` path, bad `envVars`, or an `input`/`language` key | 400                 |
| Unsupported method                                                     | 405                 |
| Request or code limit exceeded                                         | 413                 |
| Non-JSON Content-Type                                                  | 415                 |
| Service Binding failure                                                | 502                 |

## Size and validation

Validated on September 5, 2026 with Wrangler 4.129.0 and workerd 1.20260903.1.

| Component                                          |                        Uncompressed size |
| --------------------------------------------------- | ----------------------------------------: |
| SpiderMonkey engine, bridge, and fuel-instrumented Wasm | Approximately 26.70 MiB               |
| Complete JavaScript Worker, dry-run                |                    Approximately 26.70 MiB |
| Gateway with all four runtime descriptors          |                       Approximately 6 KiB |

UI files are served through Static Assets separately from Worker code. All runtime bundles fit within 64 MiB; see [language runtimes](/reference/limits) for other engines' sizes. Execution has been verified through local Service Bindings and the browser UI. Production uploads, cold starts, CPU/memory billing, and concurrent workloads have not been validated. Local `durationMs` measurements are not production performance guarantees.

```sh
pnpm run check
pnpm test             # Real Wasm tests across all four languages
pnpm run test:http    # Requires a running localhost:8787 Playground
pnpm run dry-run      # Rebuild and inspect all five Workers
```

Set `SANDBOX_URL` to change the HTTP test target. JavaScript coverage includes normal and async execution, BigInt/private fields, syntax errors, examples, state isolation, infinite loops, recursion, expensive regular expressions, denied networking, `Intl`, `SharedArrayBuffer`/`Atomics` removal, and console/memory/result limits.

## Limits and boundaries

- Every request creates a fresh Wasm instance and memory.
- `scripts/instrument.mjs` inserts fuel calls at every function entry and loop. Fuel is 50,000,000 for JavaScript, using SpiderMonkey's own interrupt mechanism rather than a synchronous trap: once the budget hits zero the host writes the engine's interrupt words and lets execution continue until SpiderMonkey observes the request at its own periodic check, with a hard backstop that throws `ExecutionLimitError` if ticking continues for another full budget past zero. This covers guest loops and engine operations such as regular expressions. Fuel measures neither instructions nor milliseconds and does not account for all work performed by individual bulk-memory instructions.
- The engine enforces its own 32 MiB heap cap and 1 MiB native stack quota (`js_new`), so GC allocation failures and runaway recursion are catchable guest errors (`InternalError`) instead of trapping the whole instance. Linear memory is additionally capped at 64 MiB by the build's fuel instrumentation. The Workers isolate's memory budget also includes the JavaScript host and compiled Wasm; these caps are not a guarantee about total memory consumption, and concurrent requests need separate load testing.
- The Playground's JavaScript Worker sets `cpu_ms: 2000` for Paid plans. The larger upload limit does not increase CPU or memory budgets. Free plans have a separate CPU allowance and do not use this Paid-only configuration.
- Code is limited to 64 KiB, requests to 96 KiB, console output to 200 entries or 32,768 UTF-16 code units combined across `stdout`/`stderr`, and the serialized result to 64 KiB. These limits are reported as a normal `error: { name: "ExecutionLimitError", ... }` result (HTTP 200), and console output produced before the limit was hit is preserved.
- Outbound fetch, host files, and the Worker's own environment variables are unavailable to the guest. Only the key/value pairs passed in `envVars` are visible to guest code, as `process.env`. Pure promise-based computation is supported; timers and indefinitely pending promises are not.
- JavaScript compatibility depends on the distributed SpiderMonkey version. Full Test262 conformance has not been measured. There are no Web builtins; `Intl` is available and backed by real ICU data.
- The demo API does not include authentication or rate limiting. Add these at the gateway when operating it as a public service.

## Deploy

```sh
pnpm run build
pnpm run dry-run
npx wrangler login
pnpm run deploy:engines
pnpm run deploy:gateway
```

Deploy engines first. Their `workers_dev` and `preview_urls` settings are false, and they have no public routes. Applications call them through Service Bindings. If a name conflicts with an existing Worker in your account, update the runtime configuration and its corresponding binding service name together.

## Other runtimes

Python, Perl, and Ruby have independent `packages/<language>` packages and Workers. See [language runtimes](/reference/limits) for engines, limits, and build details. All four engines but Ruby (which uses the official RubyVM ABI) share the same wasmify protobuf ABI described here.

## References and dependencies

- [Cloudflare's uncompressed 64 MiB limit](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)
- [goccy/spidermonkey-wasm](https://github.com/goccy/spidermonkey-wasm)
- [StarlingMonkey](https://github.com/bytecodealliance/StarlingMonkey)
- [Static Wasm imports in Workers](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)

Dependencies are pinned in `pnpm-lock.yaml`. Generated Wasm is excluded from Git and rebuilt with `pnpm run build:languages` (all four engines, including JavaScript). Distributed engines remain subject to their upstream licenses and third-party notices; see `packages/javascript/THIRD_PARTY_NOTICES.md`.
