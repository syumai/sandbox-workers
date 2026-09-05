# @sandbox-workers/python

A Cloudflare Workers Service Binding runtime containing CPython 3.14.6 compiled to Wasm. Version 0.1.0 preview; not yet published to npm.

## Quick start

After the first npm release:

```sh
npx @sandbox-workers/python init my-python
cd my-python
npm install
npm run dry-run
npm run deploy
```

Before publication, install the local tarball produced by the repository's `npm run pack`.

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
const sandbox = createSandbox(env.SANDBOX, "python");
const output = await sandbox.execute({
  code: 'return input["x"] ** 2',
  input: { x: 12 },
});
// output.result === 144
```

## Execution contract

`POST /execute` accepts `{language: "python", code, input}`. The language may be omitted when calling this runtime Worker directly. Code is a function body. JSON input is available as `input`; use `return` for the result. Standard output is captured in the response's `logs`. Return values must be representable as JSON.

Each execution creates a fresh Wasm instance. Host environment variables, networking, and files are unavailable. Limits include 64 KiB of code, a 96 KiB request, 32 KiB of standard output, 64 MiB of Wasm linear memory, and a fuel budget. Installing external packages or arbitrary native extensions is unsupported.

This build's `_decimal` module requires unresolved mpdecimal host functions. It and dependent modules such as `decimal`, `fractions`, and `statistics` are unsupported.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses and upstream sources.
