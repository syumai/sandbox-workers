# {{language}} sandbox Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2F{{language}})

Deploy this directory as a standalone project. It creates a private {{language}} Worker for Service Bindings. A Workers Paid plan is required by the configured CPU limit.

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
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-{{language}}" }] }
```

Call `env.SANDBOX.fetch()` with a JSON POST to `https://sandbox.internal/execute` containing `{ code, envVars }`. This Worker always executes {{language}}; the runtime is determined by the Service Binding, not by the request. Code is a script: the value of the last expression is the result. Env vars (string values only) are available as `process.env.NAME` (JavaScript), `os.environ["NAME"]` (Python), `$ENV{NAME}` (Perl), or `ENV["NAME"]` (Ruby). The JavaScript runtime also accepts TypeScript automatically, with no separate option: it parses code as JavaScript first, then strips (but does not check) TypeScript-only syntax only if that parse fails; `import`/`export` remain unsupported in both dialects.

Public and preview URLs are disabled. Deploying the runtime does not deploy the Playground or create the caller's Service Binding.

{{#sessions}}
## Sessions

This template's `wrangler.jsonc` includes a `SESSIONS` Durable Object binding (`SandboxSession`, with a `new_sqlite_classes` migration), so callers can also open a named, durable session instead of the stateless `runCode`:

```ts
import { createSandbox } from "@sandbox-workers/core";

const sandbox = createSandbox(env.SANDBOX);
const session = sandbox.session("user-42");
await session.runCode(code, { envVars, cwd });
```

A session keeps top-level variables, functions, and a writable `/workspace` alive across calls, surviving Durable Object eviction, hibernation, and redeploys via a linear-memory snapshot taken after each execution. See [the sessions guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/sessions.md) for language-specific REPL semantics, the files API, the snapshot mechanism, and limits.
{{/sessions}}
{{^sessions}}
## Sessions

Sessions (durable, stateful REPLs backed by a Durable Object) are not supported for Ruby: its initial memory and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other languages use. This template only serves the stateless `POST /execute`. See [the sessions guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/sessions.md).
{{/sessions}}

## Licenses

Review this project's `LICENSE`, the generated `runtime/LICENSE`, and `runtime/THIRD_PARTY_NOTICES.md` before use or redistribution. Bundled interpreters retain their upstream licenses, included in `runtime/licenses/`; the MIT license for sandbox-workers code does not replace them.
