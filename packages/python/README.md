# @sandbox-workers/python

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fpython)

Use the source template before npm publication. It creates a private Worker; configure your caller’s Service Binding after deployment. The source repository must be public for the button to work.

A Cloudflare Workers Service Binding runtime containing CPython 3.14.6 compiled to Wasm. Version 0.1.0 preview; not yet published to npm.

## Quick start

After the first npm release:

```sh
pnpm dlx @sandbox-workers/cli init python my-python
cd my-python
pnpm install
pnpm run dry-run
pnpm run deploy
```

Before publication, install the local tarball produced by the repository's `pnpm run pack`.

The initializer refuses to overwrite existing files. Choose a Worker name in `wrangler.jsonc` that fits your account. Public URLs are disabled. Use a Paid plan for execution: interpreter initialization can exceed the Free plan's CPU allowance.

## Existing Worker project

Use this entrypoint in a dedicated Worker:

```js
export { default } from "@sandbox-workers/python";
```

Add a Data module rule for the bundled standard library. The initializer includes this configuration automatically:

```jsonc
{
  "rules": [{ "type": "Data", "globs": ["**/*.bin"], "fallthrough": true }],
}
```

Disable `workers_dev` and `preview_urls`, deploy the runtime, and add a Service Binding to the calling application's configuration:

```json
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-python" }] }
```

The service name must match the deployed Worker. Install `@sandbox-workers/core` in the calling application:

```js
import { createSandbox } from "@sandbox-workers/core";
const sandbox = createSandbox(env.SANDBOX);
const output = await sandbox.runCode(
  'import os\nint(os.environ["X"]) ** 2',
  { envVars: { X: "12" } },
);
// output.results[0].text === "144"
```

## Execution contract

`POST /execute` accepts `{ code, envVars }`. This runtime Worker always executes Python; the runtime is chosen by the Service Binding, not by the request. Code is a **script**: the value of the last top-level expression is the result; an explicit top-level `return` is a SyntaxError. Env vars are available as `os.environ["NAME"]`. Standard output is captured in the response's `logs.stdout`. Container results (`dict`/`list`) are returned as `{ json }`; everything else is returned as `{ text: repr(v) }`.

Each execution creates a fresh Wasm instance; no context persists between calls. Host environment variables, networking, and files are unavailable — only the key/value pairs passed in `envVars` are visible. Limits include 64 KiB of code, a 96 KiB request, 32 KiB of combined stdout/stderr, 64 MiB of Wasm linear memory, a 64 KiB serialized result, and a fuel budget. Installing external packages or arbitrary native extensions is unsupported.

This build's `_decimal` module requires unresolved mpdecimal host functions. It and dependent modules such as `decimal`, `fractions`, and `statistics` are unsupported.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses and upstream sources.
