# @sandbox-workers/ruby

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)

Use the source template before npm publication. It creates a private Worker; configure your caller’s Service Binding after deployment. The source repository must be public for the button to work.

A Cloudflare Workers Service Binding runtime containing CRuby 4.0.0 compiled to Wasm. Version 0.1.0 preview; not yet published to npm.

## Quick start

After the first npm release:

```sh
pnpm dlx @sandbox-workers/cli init ruby my-ruby
cd my-ruby
pnpm install
pnpm run dry-run
pnpm run deploy
```

Before publication, install the local tarball produced by the repository's `pnpm run pack`.

The initializer refuses to overwrite existing files. Choose a Worker name in `wrangler.ruby.jsonc` that fits your account. Public URLs are disabled. Use a Paid plan for execution: interpreter initialization can exceed the Free plan's CPU allowance.

## Existing Worker project

Use this entrypoint in a dedicated Worker:

```js
export { default } from "@sandbox-workers/ruby";
```

Disable `workers_dev` and `preview_urls`, deploy the runtime, and add a Service Binding to the calling application's configuration:

```json
{ "services": [{ "binding": "RUBY", "service": "sandbox-ruby" }] }
```

The service name must match the deployed Worker. Install `@sandbox-workers/core` in the calling application:

```js
import { runCode } from "@sandbox-workers/core";
const output = await runCode(env.RUBY, 'x = ENV["X"].to_i\nx ** 2', {
  envVars: { X: "12" },
});
// output.results[0].text === "144"
```

Ruby has no `Interpreter` Durable Object and does not support code contexts:
`GET /interpreter` on this Worker always reports `contexts: false`, so a
caller's `sandbox.interpreter.createCodeContext({ binding: "RUBY" })` fails
with `ValidationFailedError`, and `sandbox.interpreter.runCode(code, { binding: "RUBY" })`
(no context) runs statelessly instead, the same as the free `runCode` above
— no Durable Object binding or migration needed on this Worker.

## Execution contract

`POST /execute` accepts `{ code, envVars }`. This runtime Worker always executes Ruby; the runtime is chosen by the Service Binding, not by the request. Code is a **script**: the value of the last top-level expression is the result. Env vars are available as `ENV["NAME"]`. Standard output is captured in the response's `logs.stdout`. Hash/Array results are returned as `{ json }`; everything else is returned as `{ text: v.inspect }`.

Each execution creates a fresh Wasm instance; no context persists between calls. Host environment variables, networking, and files are unavailable — only the key/value pairs passed in `envVars` are visible. Limits include 64 KiB of code, a 96 KiB request, 32 KiB of combined stdout/stderr, 96 MiB of Wasm linear memory, a 64 KiB serialized result, and a fuel budget. Installing external packages or arbitrary native extensions is unsupported.

Ruby's JavaScript bridge is disabled. APIs such as `JS.global` cannot access the Worker host.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses and upstream sources.
