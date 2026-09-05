# sandbox-workers

Deploy Wasm language runtimes to your own Cloudflare account and execute code through Service Bindings. This repository's website is the **sandbox-workers Playground**, a demo that uses the same runtime packages you deploy.

| Project                       | Purpose                                                     | Package                       |
| ----------------------------- | ----------------------------------------------------------- | ----------------------------- |
| `packages/javascript`         | SpiderMonkey Wasm, host adapter, and Worker                 | `@sandbox-workers/javascript` |
| `packages/python`             | CPython 3.14.6 Wasm, standard library, and Worker           | `@sandbox-workers/python`     |
| `packages/perl`               | Perl 5.42.2 Wasm, standard library, and Worker              | `@sandbox-workers/perl`       |
| `packages/ruby`               | CRuby 4.0.0 Wasm, standard library, and Worker              | `@sandbox-workers/ruby`       |
| `packages/cli`                | Shared runtime initializer                                  | `@sandbox-workers/cli`        |
| `website`                     | Blume documentation site                                    | Private workspace package     |
| `packages/core`               | Shared execution protocol and typed Service Binding client  | `@sandbox-workers/core`       |
| Root `src/`, `ui/`, `engine/` | Playground gateway, editor UI, and deployment configuration | Private; not published to npm |

Version 0.1.0 packages are prepared, but **have not been published to npm**. JavaScript, Python, Perl, and Ruby each run in a separate Worker. See [language runtimes](docs/languages.md) for compatibility limits and the PHP evaluation.

## Deploy to Cloudflare

Each button creates one private runtime Worker. Add its deployed name as a Service Binding in your caller afterward. These source templates do not depend on unpublished npm packages.

| Runtime    | Deploy                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript) |
| Python     | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fpython)     |
| Perl       | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fperl)       |
| Ruby       | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)       |

The source repository and template directories must be public and available on `main` before others can use these buttons. The templates require a Workers Paid plan. Read each runtime's `LICENSE` and `THIRD_PARTY_NOTICES.md` before use or redistribution.

Documentation is built with **Blume** and served at `/docs/` alongside the Playground. Run `pnpm docs:dev` for docs-only development, `pnpm build:docs` to build, and `pnpm docs:check` to validate links. Source pages live in `website/content/`.

## Deploy a runtime

These commands apply after the first npm release. For local tarballs, see the packaging section below.

```sh
pnpm dlx @sandbox-workers/cli init javascript my-sandbox
cd my-sandbox
pnpm install
pnpm run dry-run
pnpm run deploy
```

The generated Worker entrypoint is one line:

```js
export { default } from "@sandbox-workers/javascript";
```

Packages include **prebuilt Wasm**, so consumers do not need the Fastly SDK, Wizer, Binaryen, or a C++ compiler. The default Worker name is `sandbox-javascript`; choose a unique name in your account before deploying. Public and preview URLs are disabled.

Add a Service Binding to your application's `wrangler.jsonc`:

```jsonc
{
  "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }],
}
```

Install `@sandbox-workers/core` in the calling application:

```ts
import { createSandbox } from "@sandbox-workers/core";

export default {
  async fetch(request, env) {
    const sandbox = createSandbox(env.SANDBOX);
    const output = await sandbox.execute({
      code: "console.log(input.x); return await Promise.resolve(input.x ** 2);",
      input: { x: 12 },
    });
    return Response.json(output);
  },
};
```

A Service Binding targets a **Worker deployed in your account**. Deploy the runtime before the calling application. The client sends code only to that binding, never to the public Playground. The core package is optional if you call `binding.fetch()` directly.

### Python, Perl, and Ruby

Replace `javascript` in the installation commands with `python`, `perl`, or `ruby`. Specify the language in the client, for example `createSandbox(env.SANDBOX, 'python')`. Each initializer generates the required configuration, including Data module rules for the Python and Perl standard libraries.

## Develop the Playground

Requires Node.js 22.12 or later (tested with 24.18) and pnpm 10.7.1.

```sh
ppnpm add --frozen-lockfile
pnpm run dev
# http://localhost:8787
```

`pnpm run build` creates the engine snapshots and fuel instrumentation, builds package JavaScript and types, then builds the UI. The first build requires network access and can take several minutes. Runtime Workers import the packages' public entrypoints; the gateway imports only their lightweight `/metadata` exports.

```sh
pnpm run build:ui        # UI changes
pnpm run build:packages  # Host/core changes; no Wasm rebuild
pnpm run build:engine    # JavaScript guest or instrumentation changes
pnpm run build:languages # Download, verify, and instrument Python, Perl, and Ruby
pnpm run check
pnpm test
pnpm run test:http      # HTTP checks for all four languages; requires a running Playground
pnpm run dry-run        # Rebuild and inspect all five Workers without deploying
```

Python and Perl release downloads are verified against pinned SHA-256 digests. Ruby uses a pinned npm distribution. Consumers of published packages do not run these build steps.

JavaScript code runs as an async function body with `return`, `await`, JSON input, and console output. ES module imports, Node/npm resolution, and external networking are unsupported. Python, Perl, and Ruby run function bodies with JSON input and return values; Perl receives input as `$input`. The editor includes language-specific examples, syntax highlighting, output tabs, local draft storage, and Cmd/Ctrl+Enter execution.

Use a Paid plan for runtime performance evaluation. The 64 MiB upload limit is separate from CPU and runtime memory limits. Validation so far covers local workerd and dry-run builds; production CPU time and concurrent workloads have not been measured.

## Package and validate

```sh
pnpm run pack
# dist/sandbox-workers-cli-0.1.0.tgz
# dist/sandbox-workers-core-0.1.0.tgz
# dist/sandbox-workers-javascript-0.1.0.tgz
# dist/sandbox-workers-python-0.1.0.tgz
# dist/sandbox-workers-perl-0.1.0.tgz
# dist/sandbox-workers-ruby-0.1.0.tgz
pnpm run test:package
```

Package tests install tarballs outside the workspace and verify the initializer, overwrite protection, private Worker configuration, typed client, and Wrangler dry-run builds. Runtime packages include executable JavaScript, types, Wasm, documentation, and licenses. They do not require the Playground or its build dependencies.

To try a local tarball manually:

```sh
node packages/cli/bin/cli.mjs init javascript /tmp/my-sandbox
cd /tmp/my-sandbox
pnpm add /absolute/path/to/dist/sandbox-workers-javascript-0.1.0.tgz
pnpm run dry-run
```

## Release

1. Log in to npm with permission to publish under the `@sandbox-workers` scope.
2. Update package versions, Playground dependencies, and runtime metadata together, then run `pnpm add`.
3. Run `pnpm run pack`, `pnpm run check`, `pnpm test`, and `pnpm run test:package`.
4. Review each runtime's upstream licenses and corresponding sources in its `THIRD_PARTY_NOTICES.md`.
5. Publish the exact tarballs that were validated.

```sh
npm publish dist/sandbox-workers-cli-0.1.0.tgz --access public
npm publish dist/sandbox-workers-core-0.1.0.tgz --access public
npm publish dist/sandbox-workers-javascript-0.1.0.tgz --access public
npm publish dist/sandbox-workers-python-0.1.0.tgz --access public
npm publish dist/sandbox-workers-perl-0.1.0.tgz --access public
npm publish dist/sandbox-workers-ruby-0.1.0.tgz --access public
```

These are release instructions; publication has not been performed. Deploy the Playground separately with `pnpm run deploy:engines`, followed by `pnpm run deploy:gateway`. Updating an npm dependency does not update a running Worker until the consumer redeploys it.

## Add another runtime

Create `packages/<language>` with an independent Worker, Wasm engine, and metadata export, published as `@sandbox-workers/<language>`. Keep the shared JSON contract in core and language-specific engines, dependencies, and limits in their runtime packages. Register it in the shared CLI, then add a Service Binding, registry entry, editor extension, and examples to the Playground.

[JavaScript architecture](docs/runtime.md) · [Language runtimes](docs/languages.md) · [JavaScript package](packages/javascript/README.md) · [Shared client](packages/core/README.md)

## License

Original sandbox-workers code is licensed under the [MIT License](LICENSE), copyright (c) 2026 syumai. Bundled interpreters and third-party components retain their upstream licenses; see each runtime package's `THIRD_PARTY_NOTICES.md` and `licenses/` directory.
