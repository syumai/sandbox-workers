# python sandbox Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fpython)

Deploy this directory as a standalone project. It creates a private python Worker for Service Bindings. A Workers Paid plan is required by the configured CPU limit.

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
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-python" }] }
```

Call `env.SANDBOX.fetch()` with a JSON POST to `https://sandbox.internal/execute` containing `{language: "python", code, envVars}`. Code is a script: the value of the last expression is the result. Env vars (string values only) are available as `process.env.NAME` (JavaScript), `os.environ["NAME"]` (Python), `$ENV{NAME}` (Perl), or `ENV["NAME"]` (Ruby).

Public and preview URLs are disabled. Deploying the runtime does not deploy the Playground or create the caller's Service Binding.

## Sessions

This template's `wrangler.jsonc` includes a `SESSIONS` Durable Object binding (`SandboxSession`, with a `new_sqlite_classes` migration), so callers can also open a named, durable session instead of the stateless `runCode`:

```ts
import { createSandbox } from "@sandbox-workers/core";

const sandbox = createSandbox(env.SANDBOX, "python");
const session = sandbox.session("user-42");
await session.runCode(code, { envVars, cwd });
```

A session keeps top-level variables, functions, and a writable `/workspace` alive across calls for as long as its Durable Object stays in memory (persistence across eviction is a later phase). See [the sessions guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/sessions.md) for language-specific REPL semantics, the files API, and limits.

## Licenses

Review this project's `LICENSE`, the generated `runtime/LICENSE`, and `runtime/THIRD_PARTY_NOTICES.md` before use or redistribution. Bundled interpreters retain their upstream licenses, included in `runtime/licenses/`; the MIT license for sandbox-workers code does not replace them.
