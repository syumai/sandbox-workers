# @sandbox-workers/javascript

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript)

Use the source template before npm publication. It creates a private Worker; configure your caller’s Service Binding after deployment. The source repository must be public for the button to work.

A deployable JavaScript sandbox Worker powered by SpiderMonkey WebAssembly from
`@fastly/js-compute@3.45.0`. The npm artifact includes the compiled engine and host
adapter. Consumers need Wrangler, **not** Fastly, Binaryen, Wizer or a C++ compiler.

## Quick start

These registry commands apply after the first npm release. Until then, install
the `.tgz` produced by the repository's `pnpm run pack`.

```sh
pnpm dlx @sandbox-workers/cli init javascript my-sandbox
cd my-sandbox
pnpm install
pnpm run dry-run
pnpm run deploy
```

The initializer only creates local files. It never installs dependencies or
publishes/deploys anything. It refuses to overwrite existing project files.
Choose your own Worker name before deploying. Default: `sandbox-javascript`.
`workers_dev` and `preview_urls` are disabled and there are no public routes.
On Paid plans you can optionally set `limits.cpu_ms: 1000`; the generated
configuration also works without that Paid-only setting.

## Existing project

```sh
pnpm add @sandbox-workers/javascript
pnpm add -D wrangler
```

```js
// index.js
export { default } from "@sandbox-workers/javascript";
```

```jsonc
// wrangler.jsonc
{
  "name": "sandbox-javascript",
  "main": "index.js",
  "compatibility_date": "2026-09-04",
  "workers_dev": false,
  "preview_urls": false,
}
```

Deploy this dedicated Worker, then add to your caller's Wrangler configuration:

```jsonc
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }] }
```

```ts
// In your caller (pnpm add @sandbox-workers/core)
import { createSandbox } from "@sandbox-workers/core";
const sandbox = createSandbox(env.SANDBOX);
const result = await sandbox.execute({
  code: "return input.x ** 2;",
  input: { x: 12 },
});
```

Or use `env.SANDBOX.fetch(new Request('https://sandbox.internal/execute', ...))`
with a JSON POST body `{ "language": "javascript", "code": "return 42" }`.
Both Workers must be deployed in your own Cloudflare account. A Service Binding
is to a deployed Worker name; installing this npm package alone does not create it.
For local development run both Wrangler projects, or pass both `-c` configs to
one `wrangler dev` command.

## Exports

- `@sandbox-workers/javascript`: default Worker handler (imports Wasm).
- `@sandbox-workers/javascript/metadata`: lightweight `javascriptRuntime`
  descriptor (no Wasm import), for runtime catalogs and capability discovery.

## Execution contract and limits

Code is an async function body (`return` / `await`, `input` contains JSON).
Console logs, JSON result, duration and fuel/memory metrics are returned.
BigInt becomes a string ending in `n`; undefined results become null.
ES-module imports, npm resolution, Node APIs, external networking and files are
not provided. Pure promises and supported Fastly Web builtins work; timers and
indefinitely pending promises are unsupported.

Every execution creates a fresh Wasm instance. Fuel bounds engine function/loop
entries to 5,000,000; the linear memory maximum is 64 MiB. Code is limited to
64 KiB, request to 96 KiB and result body to 128 KiB. Console capture is bounded
to 200 entries / 32,768 UTF-16 code units. CPU/isolate overhead and concurrent
memory use still need to fit Cloudflare's separate resource limits.

This is an experimental runtime, not a claim of full Test262 conformance or a
production security audit. The demo is independent of your deployment.
See THIRD_PARTY_NOTICES.md for the embedded runtime licenses and source references.
