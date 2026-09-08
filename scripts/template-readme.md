# {{language}} sandbox Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2F{{language}})

Deploy this directory as a standalone project. It creates a private {{language}} Worker for Service Bindings. A Workers Paid plan is required by the configured CPU limit.

The build downloads a pinned source archive, verifies its SHA-256 digest, installs locked dependencies, and builds this runtime. It does not require the npm packages or sibling directories. Initial builds take several minutes. `runtime-source.json` records the source revision and digest; update both together to upgrade. The pinned historical source uses npm internally, independently of the current repository's pnpm workspace.

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

Call `env.SANDBOX.fetch()` with a JSON POST to `https://sandbox.internal/execute` containing `{ code, envVars }` for one-shot, stateless execution, or use the free `runCode` helper instead:

```ts
import { runCode } from "@sandbox-workers/core";
const result = await runCode(env.SANDBOX, code, { envVars: { X: "12" } });
```

This Worker always executes {{language}}; the runtime is determined by the Service Binding, not by the request. Code is a script: the value of the last expression is the result. Env vars (string values only) are available as `process.env.NAME` (JavaScript), `os.environ["NAME"]` (Python), `$ENV{NAME}` (Perl), or `ENV["NAME"]` (Ruby). The JavaScript runtime also accepts TypeScript automatically, with no separate option: it parses code as JavaScript first, then strips (but does not check) TypeScript-only syntax only if that parse fails; `import`/`export` remain unsupported in both dialects.

Public and preview URLs are disabled. Deploying the runtime does not deploy the Playground or create the caller's Service Binding.

{{#sessions}}
## Sandboxes and code contexts

This template's `wrangler.jsonc` includes an `INTERPRETER` Durable Object binding (`Interpreter`, with a `new_sqlite_classes` migration), so your own Worker (the caller) can host a `Sandbox` Durable Object (from `@sandbox-workers/core`) and open a durable sandbox with one or more named **code contexts** bound to this Worker by name, instead of the stateless `runCode` above:

```jsonc
// your wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "services": [{ "binding": "{{BINDING}}", "service": "sandbox-{{language}}" }]
}
```

```ts
// your Worker's entry
export { Sandbox } from "@sandbox-workers/core";
```

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.Sandbox, "user-42");
const ctx = await sandbox.interpreter.createCodeContext({ binding: "{{BINDING}}", cwd, envVars });
await sandbox.interpreter.runCode(code, { context: ctx });
```

A code context keeps top-level variables and functions alive across calls, surviving Durable Object eviction, hibernation, and redeploys via a linear-memory snapshot taken after each execution; a `/workspace` is shared by every context in the sandbox, including contexts bound to other runtime Workers. See [the sandboxes and code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/stateful/code-contexts.md) for language-specific REPL semantics, the files API, the snapshot mechanism, and limits.

An idle sandbox is deleted automatically by your caller's own `Sandbox` Durable Object, based on `SANDBOX_IDLE_TTL_MS` (milliseconds, as a string) under `vars` in *your* `wrangler.jsonc` — it defaults to 24 hours (`86400000`) if unset, and `"0"` disables expiry entirely. This Worker's own `Interpreter` Durable Object (holding each context's memory snapshot) expires independently via `INTERPRETER_IDLE_TTL_MS` under `vars` in *this* `wrangler.jsonc`, with the same defaults — set it to at least `SANDBOX_IDLE_TTL_MS`, or a context's globals can already be gone (`ContextNotFoundError`) while the sandbox still lists it. For example:

```jsonc
// this Worker's wrangler.jsonc
{
  "vars": { "INTERPRETER_IDLE_TTL_MS": "3600000" }, // 1 hour; "0" disables expiry
}
```
{{/sessions}}
{{^sessions}}
## Sandboxes and code contexts

Code contexts (durable, stateful REPLs backed by a Durable Object) are not supported for Ruby: its initial memory and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other languages use. This template only serves the stateless `POST /execute`. See [the sandboxes and code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/stateful/code-contexts.md).
{{/sessions}}

## Licenses

Review this project's `LICENSE`, the generated `runtime/LICENSE`, and `runtime/THIRD_PARTY_NOTICES.md` before use or redistribution. Bundled interpreters retain their upstream licenses, included in `runtime/licenses/`; the MIT license for sandbox-workers code does not replace them.
