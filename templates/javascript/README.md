# javascript sandbox Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript)

Deploy this directory as a standalone project. It creates a private javascript Worker for Service Bindings. A Workers Paid plan is required by the configured CPU limit.

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
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }] }
```

Call `env.SANDBOX.fetch()` with a JSON POST to `https://sandbox.internal/execute` containing `{ code, envVars }`. This Worker always executes javascript; the runtime is determined by the Service Binding, not by the request. Code is a script: the value of the last expression is the result. Env vars (string values only) are available as `process.env.NAME` (JavaScript), `os.environ["NAME"]` (Python), `$ENV{NAME}` (Perl), or `ENV["NAME"]` (Ruby). The JavaScript runtime also accepts TypeScript automatically, with no separate option: it parses code as JavaScript first, then strips (but does not check) TypeScript-only syntax only if that parse fails; `import`/`export` remain unsupported in both dialects.

Public and preview URLs are disabled. Deploying the runtime does not deploy the Playground or create the caller's Service Binding.

## Sandboxes and code contexts

This template's `wrangler.jsonc` includes a `SANDBOX` Durable Object binding (`Sandbox`, with a `new_sqlite_classes` migration), so callers can also open a durable sandbox with one or more named **code contexts** instead of the stateless `runCode`:

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.SANDBOX, "user-42");
const ctx = await sandbox.createCodeContext({ cwd, envVars });
await sandbox.runCode(code, { context: ctx });
```

A code context keeps top-level variables and functions alive across calls, surviving Durable Object eviction, hibernation, and redeploys via a linear-memory snapshot taken after each execution; a `/workspace` is shared by every context in the sandbox. See [the sandboxes and code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/sessions.md) for language-specific REPL semantics, the files API, the snapshot mechanism, and limits.

An idle sandbox is deleted automatically by a Durable Object alarm. Set `SESSION_IDLE_TTL_MS` (milliseconds, as a string) under `vars` in this template's `wrangler.jsonc` to change the timeout — it defaults to 24 hours (`86400000`) if unset, and `"0"` disables expiry entirely, for example:

```jsonc
// wrangler.jsonc
{
  "vars": { "SESSION_IDLE_TTL_MS": "3600000" }, // 1 hour; "0" disables expiry
}
```

## Licenses

Review this project's `LICENSE`, the generated `runtime/LICENSE`, and `runtime/THIRD_PARTY_NOTICES.md` before use or redistribution. Bundled interpreters retain their upstream licenses, included in `runtime/licenses/`; the MIT license for sandbox-workers code does not replace them.
