# sandbox-workers JavaScript runtime

Submit arbitrary JavaScript to `POST /execute` and execute it inside **SpiderMonkey compiled to Wasm**. The sandbox-workers Playground provides a CodeMirror editor, JSON input, console/result/raw JSON tabs, execution metrics, and examples.

## Architecture

```text
Browser / API client
        │ POST /execute { language, code, input }
        ▼
sandbox-playground                 src/index.ts
  ├── Static Assets / CodeMirror   ui/
  └── language → Service Binding
        │ JAVASCRIPT
        ▼
sandbox-engine-javascript          engine/index.ts (public URLs disabled)
  └── Allowed Fastly/WASI APIs     packages/javascript/src/host.mjs
        └── Fresh Wasm instance per request
              └── SpiderMonkey + guest.js
```

The runtime uses the engine distribution and CLI from `@fastly/js-compute@3.45.0`. Following Fastly's build flow, Wizer initializes the guest HTTP handler ahead of time and snapshots it with the engine. Submitted code is compiled as an AsyncFunction inside Wasm for each request. It is not embedded into the snapshot or evaluated by the Worker host's V8 engine.

The adapter implements the Fastly HTTP body/request/response APIs, randomness, clocks, and other operations needed for JSON exchange. Unsupported host capabilities throw explicit errors. Wasm is statically imported, so the Worker does not need dynamic Wasm compilation.

## Run locally

Requires Node.js 22.12 or later (tested with 24.18), npm, and an operating system supported by Wizer.

```sh
ppnpm add --frozen-lockfile
pnpm run dev
```

Open [localhost:8787](http://localhost:8787). The command builds the engines, packages, and UI, then starts the gateway and four runtime Workers. The first build can take several minutes. After UI changes, run `pnpm run build:ui` in another terminal. JavaScript guest changes require `pnpm run build:engine`.

The editor supports completion, syntax highlighting, line numbers, folding, bracket matching, search, and undo/redo. Cmd/Ctrl+Enter runs the code. Draft code and JSON input are saved in local storage.

```sh
curl http://localhost:8787/execute \
  -H 'Content-Type: application/json' \
  --data '{"language":"javascript","code":"console.log(input.x); return await Promise.resolve(input.x ** 2);","input":{"x":12}}'
```

```json
{
  "ok": true,
  "result": 144,
  "logs": [{ "level": "log", "text": "12" }],
  "usage": {
    "fuelConsumed": 13000,
    "fuelLimit": 5000000,
    "memoryBytes": 7667712
  },
  "language": "javascript",
  "engine": "SpiderMonkey / Fastly 3.45.0",
  "durationMs": 8
}
```

Metric values above are illustrative. Code is an **async function body**: it can use `return` and `await`, and receives a JSON value as `input`. Missing or undefined results become null. BigInt values become strings such as `"18446744073709551616n"`. Other results follow JSON serialization rules; circular references fail. ES module `import`/`export`, npm resolution, and a Node.js environment are not provided.

`GET /languages` lists supported languages, execution modes, capabilities, and limits.

| JavaScript response                                                  | HTTP status     |
| -------------------------------------------------------------------- | --------------- |
| Success or guest syntax/runtime error                                | 200; check `ok` |
| Invalid JSON, unsupported language, denied host API, or engine error | 400             |
| Unsupported method                                                   | 405             |
| Request or code limit exceeded                                       | 413             |
| Non-JSON Content-Type                                                | 415             |
| Fuel or host output limit exceeded                                   | 422             |
| Service Binding failure                                              | 502             |

## Size and validation

Validated on September 5, 2026 with Wrangler 4.129.0 and workerd 1.20260903.1.

| Component                                        |                         Uncompressed size |
| ------------------------------------------------ | ----------------------------------------: |
| Fastly engine, guest, and fuel-instrumented Wasm | 11,891,318 bytes, approximately 11.34 MiB |
| Complete JavaScript Worker, dry-run              |                   Approximately 11.35 MiB |
| Gateway with all four runtime descriptors        |                       Approximately 6 KiB |

UI files are served through Static Assets separately from Worker code. All runtime bundles fit within 64 MiB; see [language runtimes](languages.md) for other engines' sizes. Execution has been verified through local Service Bindings and the browser UI. Production uploads, cold starts, CPU/memory billing, and concurrent workloads have not been validated. Local `durationMs` measurements are not production performance guarantees.

```sh
pnpm run check
pnpm test             # Real Wasm tests across all four languages
pnpm run test:http    # Requires a running localhost:8787 Playground
pnpm run dry-run      # Rebuild and inspect all five Workers
```

Set `SANDBOX_URL` to change the HTTP test target. JavaScript coverage includes normal and async execution, BigInt/private fields, syntax errors, examples, state isolation, infinite loops, recursion, expensive regular expressions, denied networking, and input/output/memory limits.

## Limits and boundaries

- Every request creates a fresh Wasm instance and memory.
- `scripts/meter.mjs` uses `scripts/instrument.mjs` to insert fuel calls at every function entry and loop. The host stops execution after 5,000,000 calls. This covers guest loops and engine operations such as regular expressions. Fuel measures neither instructions nor milliseconds and does not account for all work performed by individual bulk-memory instructions.
- Linear memory is capped at 64 MiB. The Workers isolate's memory budget also includes the JavaScript host and compiled Wasm. The linear-memory cap is not a guarantee about total memory consumption; concurrent requests need separate load testing.
- The Playground's JavaScript Worker sets `cpu_ms: 1000` for Paid plans. The larger upload limit does not increase CPU or memory budgets. Free plans have a separate CPU allowance and do not use this Paid-only configuration.
- Code is limited to 64 KiB, requests to 96 KiB, console output to 200 entries or 32,768 UTF-16 code units, and the result body to 128 KiB. Diagnostic output is bounded too. Guest console output accumulated before a host-triggered stop is not returned.
- Outbound fetch, host files, Fastly stores/secrets, and Worker environment variables are unavailable to the guest. Pure promise-based computation is supported; timers and indefinitely pending promises are not.
- JavaScript compatibility depends on the distributed SpiderMonkey version. Full Test262 conformance has not been measured. Web APIs are limited to the Fastly builtins and the implemented host capabilities.
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

Python, Perl, and Ruby have independent `packages/<language>` packages and Workers. See [language runtimes](languages.md) for engines, limits, and build details. The Fastly ABI described here applies specifically to JavaScript.

## References and dependencies

- [Cloudflare's uncompressed 64 MiB limit](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)
- [Fastly js-compute-runtime](https://github.com/fastly/js-compute-runtime)
- [StarlingMonkey](https://github.com/bytecodealliance/StarlingMonkey)
- [Static Wasm imports in Workers](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)

Dependencies are pinned in `pnpm-lock.yaml`. Generated Wasm is excluded from Git and rebuilt with `pnpm run build:engine` for JavaScript or `pnpm run build:languages` for the other engines. Distributed engines remain subject to their upstream licenses and third-party notices.

`npm audit` reports a known vulnerability in Fastly's build-time `weval → decompress` dependency. This configuration does not use AOT/weval or bundle those build tools into the Worker. An upstream fix still needs tracking; Fastly has not been automatically downgraded to address the report.
