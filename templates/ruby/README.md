# ruby sandbox Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)

Deploy this directory as a standalone project. It creates a private ruby Worker for Service Bindings. A Workers Paid plan is required by the configured CPU limit.

The build downloads a pinned source archive, verifies its SHA-256 digest, installs locked dependencies, and builds this runtime. It does not require unpublished npm packages or sibling directories. Initial builds take several minutes. `runtime-source.json` records the source revision and digest; update both together to upgrade. The pinned historical source uses npm internally, independently of the current repository's pnpm workspace.

## Local development

```sh
pnpm install
pnpm dev
pnpm dry-run
pnpm run deploy
```

## Connect your application

After deployment, add this to your application's Wrangler configuration. Use the Worker name you selected during deployment:

```json
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-ruby" }] }
```

Call `env.SANDBOX.fetch()` with a JSON POST to `https://sandbox.internal/execute` containing `{ code, envVars }` for one-shot, stateless execution, or use the free `runCode` helper instead:

```ts
import { runCode } from "@sandbox-workers/core";
const result = await runCode(env.SANDBOX, code, { envVars: { X: "12" } });
```

This Worker always executes ruby; the runtime is determined by the Service Binding, not by the request. Code is a script: the value of the last expression is the result. Env vars (string values only) are available as `process.env.NAME` (JavaScript), `os.environ["NAME"]` (Python), `$ENV{NAME}` (Perl), or `ENV["NAME"]` (Ruby). The JavaScript runtime also accepts TypeScript automatically, with no separate option: it parses code as JavaScript first, then strips (but does not check) TypeScript-only syntax only if that parse fails; `import`/`export` remain unsupported in both dialects.

Public and preview URLs are disabled. Deploying the runtime does not deploy the Playground or create the caller's Service Binding.

## Sandboxes and code contexts

Code contexts (durable, stateful REPLs backed by a Durable Object) are not supported for Ruby: its initial memory and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other languages use. This template only serves the stateless `POST /execute`. See [the sandboxes and code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/code-contexts.md).

## Licenses

Review this project's `LICENSE`, the generated `runtime/LICENSE`, and `runtime/THIRD_PARTY_NOTICES.md` before use or redistribution. Bundled interpreters retain their upstream licenses, included in `runtime/licenses/`; the MIT license for sandbox-workers code does not replace them.
