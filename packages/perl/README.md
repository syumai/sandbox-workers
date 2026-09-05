# @sandbox-workers/perl

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fperl)

Use the source template before npm publication. It creates a private Worker; configure your caller’s Service Binding after deployment. The source repository must be public for the button to work.

A Cloudflare Workers Service Binding runtime containing Perl 5.42.2 compiled to Wasm. Version 0.1.0 preview; not yet published to npm.

## Quick start

After the first npm release:

```sh
pnpm dlx @sandbox-workers/cli init perl my-perl
cd my-perl
pnpm install
pnpm run dry-run
pnpm run deploy
```

Before publication, install the local tarball produced by the repository's `pnpm run pack`.

The initializer refuses to overwrite existing files. Choose a Worker name in `wrangler.jsonc` that fits your account. Public URLs are disabled. Use a Paid plan for execution: interpreter initialization can exceed the Free plan's CPU allowance.

## Existing Worker project

Use this entrypoint in a dedicated Worker:

```js
export { default } from "@sandbox-workers/perl";
```

Add a Data module rule for the bundled standard library. The initializer includes this configuration automatically:

```jsonc
{
  "rules": [{ "type": "Data", "globs": ["**/*.bin"], "fallthrough": true }],
}
```

Disable `workers_dev` and `preview_urls`, deploy the runtime, and add a Service Binding to the calling application's configuration:

```json
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-perl" }] }
```

The service name must match the deployed Worker. Install `@sandbox-workers/core` in the calling application:

```js
import { createSandbox } from "@sandbox-workers/core";
const sandbox = createSandbox(env.SANDBOX, "perl");
const output = await sandbox.runCode("my $x = $ENV{X};\n$x ** 2", {
  envVars: { X: "12" },
});
// output.results[0].text === "144"
```

## Execution contract

`POST /execute` accepts `{language: "perl", code, envVars}`. The language may be omitted when calling this runtime Worker directly. Code is a **script**: the value of the last top-level expression is the result, and an explicit top-level `return` also works. Env vars are available as `%ENV`, e.g. `$ENV{NAME}`. Standard output is captured in the response's `logs.stdout`. HASH/ARRAY ref results are returned as `{ json }`; everything else is returned as `{ text: "$v" }`.

Each execution creates a fresh Wasm instance; no context persists between calls. Host environment variables, networking, and files are unavailable — only the key/value pairs passed in `envVars` are visible. Limits include 64 KiB of code, a 96 KiB request, 32 KiB of combined stdout/stderr, 64 MiB of Wasm linear memory, a 64 KiB serialized result, and a fuel budget. Installing external packages or arbitrary native extensions is unsupported.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses and upstream sources.
