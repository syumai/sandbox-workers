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

Call `env.SANDBOX.fetch()` with a JSON POST to `https://sandbox.internal/execute` containing `{language: "{{language}}", code, input}`. Code is a function body; input is available as `input` (`$input` in Perl). Return a JSON-compatible value.

Public and preview URLs are disabled. Deploying the runtime does not deploy the Playground or create the caller's Service Binding.

## Licenses

Review this project's `LICENSE`, the generated `runtime/LICENSE`, and `runtime/THIRD_PARTY_NOTICES.md` before use or redistribution. Bundled interpreters retain their upstream licenses, included in `runtime/licenses/`; the MIT license for sandbox-workers code does not replace them.
