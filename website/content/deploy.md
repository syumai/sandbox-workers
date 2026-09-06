---
title: Deploy a runtime Worker
description: Create a runtime Worker in your account from an isolated source template, or initialize one with the CLI.
---

This guide shows you how to deploy a private engine Worker with a deploy button, and how to initialize one with the CLI instead.

## Choose a runtime

Each button deploys one private engine Worker. Repeat for each language you need; the buttons do not deploy the Playground or your calling application. Each deployed Worker becomes one `services` entry in your caller's [`wrangler.jsonc`](/configuration/wrangler), and a caller may bind several at once.

### JavaScript

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript)

### Python

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fpython)

### Perl

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fperl)

### Ruby

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)

## Complete the setup

1. Connect your GitHub account in the Cloudflare setup flow.
2. Choose your Cloudflare account, repository name, and Worker name.
3. Keep the detected build command and deploy command from the template.
4. Wait for the pinned engine source to download, pass its checksum check, and build.
5. Add a [Service Binding](/configuration/wrangler) in your caller using the selected Worker name — one Service Binding per deployed runtime Worker.

Initial builds take several minutes. The generated runtime retains upstream license notices. Review [runtime licenses](/platform/licenses) before use or redistribution. A Paid plan is required by the configured CPU limits.

## How the templates work

Cloudflare treats the selected `templates/<language>` directory as a new repository root. Each template is independent: its build script downloads an immutable source archive, verifies the SHA-256 digest in `runtime-source.json`, and builds only the chosen Wasm engine. It does not depend on sibling workspace packages or unpublished npm packages. The pinned historical snapshot builds internally with its own npm lockfile; current project development uses pnpm.

Wrangler invokes the build before deployment. A manifest verifies existing output and skips a rebuild only when its hashes and source pin match. Source verification also applies to offline test archives.

Public and preview URLs remain disabled. There are no required secrets, databases, or network bindings. The caller's Service Binding is configured separately.

## Availability

Deploy buttons require a public GitHub or GitLab source repository. While this repository is private, the buttons and anonymous source downloads are unavailable. The templates must also be pushed to the referenced `main` branch before others can use them. The Cloudflare account creation and final deployment are completed by the person clicking the button.

See Cloudflare's [Deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) for the hosting flow and repository requirements.

## Use the CLI

After npm publication, use the shared CLI:

```sh
pnpm dlx @sandbox-workers/cli init python my-sandbox
cd my-sandbox
pnpm install
pnpm dry-run
pnpm run deploy
```

```text
sandbox-workers init <javascript|python|perl|ruby> [directory] [--stateless]
sandbox-workers --help
```

The default directory is `sandbox-<runtime>`. The CLI creates an entrypoint, manifest, Wrangler configuration, README, and ignore file. Existing files and symlinks are never overwritten. It does not install packages or deploy automatically. `--stateless` may appear before or after `directory`.

Each generated entrypoint imports the selected package:

```js
export { default, Interpreter } from "@sandbox-workers/python";
```

The generated README links to that runtime's `LICENSE` and `THIRD_PARTY_NOTICES.md`. Read them before use or redistribution. The installed engine has its own upstream licenses in addition to the MIT-licensed adapter.

This deploys the **runtime Worker** only. It serves both modes: your own Worker (the caller) can call it directly with the free `runCode` for stateless mode, or separately export the `Sandbox` Durable Object from `@sandbox-workers/core` and bind this Worker by name as a Service Binding for stateful mode — see [Get started with stateless mode](/stateless/get-started) and [Get started with stateful mode](/stateful/get-started).

### Stateless-only runtime Workers

Pass `--stateless` to scaffold a stateless-only runtime Worker: no `durable_objects`/`migrations` in `wrangler.jsonc`, and the entrypoint exports only `default` (no `Interpreter` Durable Object class), so `GET /interpreter` reports `contexts: false`. This is always the case for Ruby, which has no `Interpreter` class regardless of the flag. A stateless-only runtime Worker still works normally in stateless mode — call it with the free `runCode` function:

```ts
import { runCode } from "@sandbox-workers/core";
const result = await runCode(env.PYTHON, "1 + 1"); // PYTHON: a Service Binding to this Worker
```

In stateful mode, a stateless-only runtime Worker's `contexts: false` means `createCodeContext({ binding })` against it fails with `ValidationFailedError`, and `sandbox.interpreter.runCode(code, { binding })` (no `context`) falls back to running statelessly instead.

You can get the same result by hand, without the flag: delete the `durable_objects` and `migrations` blocks from an already-generated `wrangler.jsonc` (and drop the `Interpreter` export from `index.js`, though a leftover export is harmless if the binding itself is gone). The Worker still serves plain `/execute` and `GET /interpreter`; every `/interpreters/:key/*` route then answers 400 — see [HTTP API](/api/http-api) for exactly what still works without the binding.

### Before npm publication

Use one of the deploy buttons above, or build local packages:

```sh
pnpm install --frozen-lockfile
pnpm run pack
node packages/cli/bin/cli.mjs init python /tmp/my-sandbox
cd /tmp/my-sandbox
pnpm add /absolute/path/to/dist/sandbox-workers-python-0.1.0.tgz
pnpm dry-run
```

To use npm instead of pnpm in a generated project, the equivalent `npm install` and `npm run` commands work. The repository itself is managed with pnpm workspace.
