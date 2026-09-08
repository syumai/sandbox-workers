# sandbox-workers

Self-hosted code sandboxes on Cloudflare Workers for JavaScript, Python, Perl, and Ruby. Each language runs as a Wasm runtime Worker in your own account, called through Service Bindings. This repository's website is the **sandbox-workers Playground**, a demo that uses the same runtime packages you deploy.

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

Version 0.1.0 packages are published on npm under the `@sandbox-workers` scope. JavaScript, Python, Perl, and Ruby each run in a separate Worker. See [language runtimes](docs/languages.md) for compatibility limits and the PHP evaluation.

## Deploy to Cloudflare

Each button creates one private runtime Worker. Add its deployed name as a Service Binding in your caller afterward. These source templates build from source and do not depend on the npm packages.

| Runtime    | Deploy                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript) |
| Python     | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fpython)     |
| Perl       | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fperl)       |
| Ruby       | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)       |

The source repository and template directories must be public and available on `main` before others can use these buttons. The templates require a Workers Paid plan. Read each runtime's `LICENSE` and `THIRD_PARTY_NOTICES.md` before use or redistribution.

Documentation is built with **Blume** and served at `/docs/` alongside the Playground. Run `pnpm docs:dev` for docs-only development, `pnpm build:docs` to build, and `pnpm docs:check` to validate links. Source pages live in `website/content/`.

## Deploy a runtime

These commands use the published npm packages. For local tarballs, see the packaging section below.

```sh
pnpm dlx @sandbox-workers/cli init javascript,python my-sandbox
cd my-sandbox
pnpm install
pnpm run dry-run
pnpm run deploy
```

The generated Worker entrypoint is one line:

```js
export { default, Interpreter } from "@sandbox-workers/javascript";
```

Packages include **prebuilt Wasm**, so consumers do not need Binaryen or a C++ compiler. The default Worker name is `sandbox-javascript`; choose a unique name in your account before deploying. Public and preview URLs are disabled.

Add a Service Binding to your application's `wrangler.jsonc`:

```jsonc
{
  "services": [{ "binding": "JAVASCRIPT", "service": "sandbox-javascript" }],
}
```

Install `@sandbox-workers/core` in the calling application:

```ts
import { runCode } from "@sandbox-workers/core";

export default {
  async fetch(request, env) {
    const output = await runCode(
      env.JAVASCRIPT,
      "console.log(process.env.X);\nawait Promise.resolve(Number(process.env.X) ** 2);",
      { envVars: { X: "12" } },
    );
    return Response.json(output);
  },
};
```

A Service Binding targets a **Worker deployed in your account**. Deploy the runtime before the calling application. `runCode` sends code only to that binding, never to the public Playground; it requires a Service Binding specifically (a `Sandbox` Durable Object namespace throws synchronously — see below). The core package is optional if you call `binding.fetch()` directly.

### Python, Perl, and Ruby

Replace `javascript` in the installation commands with `python`, `perl`, or `ruby`. The client takes only the binding, the code, and options, for example `runCode(env.PYTHON, code)`; the runtime is whichever Worker that binding targets. Each initializer generates the required configuration, including Data module rules for the Python and Perl standard libraries.

### Sandboxes and code contexts

`runCode` above is stateless: every call boots a fresh Wasm instance, with no persistence between calls. For a durable, stateful alternative, **your own Worker** — not the runtime Worker — hosts a `Sandbox` Durable Object (from `@sandbox-workers/core`) with a shared `/workspace` and one or more **code contexts**, each bound to a runtime Worker by the **name of a Service Binding** — there is no `language` option. Top-level variables persist across calls in the same context, surviving Durable Object eviction, hibernation, and redeploys via a memory snapshot taken after each execution. Code contexts are supported for JavaScript, Python, and Perl; Ruby does not support them, and neither does a runtime Worker generated with the CLI's `--stateless` flag — both report `contexts: false`.

```jsonc
// your wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "services": [{ "binding": "JAVASCRIPT", "service": "sandbox-javascript" }],
}
```

```ts
import { getSandbox } from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.Sandbox, "user-42");
const ctx = await sandbox.interpreter.createCodeContext({ binding: "JAVASCRIPT", cwd: "/workspace" });
await sandbox.interpreter.runCode("counter = 1", { context: ctx });
await sandbox.interpreter.runCode("counter += 1; counter", { context: ctx }); // 2
await sandbox.writeFile("/workspace/notes.txt", "hi");
await sandbox.readFile("/workspace/notes.txt");
```

One sandbox can hold contexts of several languages at once, all sharing the same `/workspace`. See the [sandboxes and code contexts guide](website/content/stateful/code-contexts.md) and [language runtimes](docs/languages.md) for the client API, the files API, per-language REPL semantics, and the snapshot mechanism.

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

Code is a **script**: the value of the last top-level expression is the result; a top-level `return` is not part of the supported contract. Data is passed with `envVars` (string values only) and read as `process.env.NAME` (JavaScript), `os.environ["NAME"]` (Python), `$ENV{NAME}` (Perl), or `ENV["NAME"]` (Ruby). No context persists between calls — every call boots a fresh Wasm instance. ES module imports, Node/npm resolution, and external networking are unsupported. The editor includes language-specific examples, syntax highlighting, output tabs, local draft storage, and Cmd/Ctrl+Enter execution.

The editor toolbar has a **Script**/**REPL** mode toggle. Script is the stateless behavior above. REPL turns the editor into a real, line-at-a-time REPL: a fixed-height, one-line prompt (pre-filled with a declaration template, and per-language SNIPPETS to insert without evaluating) submits each line against the default code context of a durable, per-browser Playground sandbox (see [Sandboxes and code contexts](#sandboxes-and-code-contexts)), appending its result to a scrolling log above the prompt — both keep a constant height as the log or a multi-line entry grows, scrolling internally instead — so top-level state and a `/workspace` directory persist between lines; the result pane then also shows sandbox status (executions, cwd, snapshot size, time until idle expiry) and a Workspace tab for browsing/editing/deleting files. Ruby has no REPL mode, since code contexts aren't supported for Ruby. The public Playground deploys with `SANDBOX_FILE_API=disabled` (see `wrangler.jsonc`), so on it the Workspace tab is hidden and guest code cannot read or write `/workspace`; run `wrangler dev` with `--var SANDBOX_FILE_API:enabled` to try the file features locally.

The JavaScript runtime also accepts TypeScript automatically: no `language` option, no separate mode — code is parsed as JavaScript first, and only code that fails to parse falls back to stripping TypeScript-only syntax (types, `interface`, generics, `as`/`satisfies`, `enum`) before running. Types are stripped, not checked, so a type error still runs like any other JavaScript mistake. `import`/`export` remain unsupported.

Use a Paid plan for runtime performance evaluation. The 64 MiB upload limit is separate from CPU and runtime memory limits. Validation so far covers local workerd and dry-run builds; production CPU time and concurrent workloads have not been measured.

## Package and validate

```sh
pnpm run pack
# dist/sandbox-workers-cli-<version>.tgz
# dist/sandbox-workers-core-<version>.tgz
# dist/sandbox-workers-javascript-<version>.tgz
# dist/sandbox-workers-python-<version>.tgz
# dist/sandbox-workers-perl-<version>.tgz
# dist/sandbox-workers-ruby-<version>.tgz
pnpm run test:package
```

Package tests install tarballs outside the workspace and verify the initializer, overwrite protection, private Worker configuration, typed client, and Wrangler dry-run builds. Runtime packages include executable JavaScript, types, Wasm, documentation, and licenses. They do not require the Playground or its build dependencies.

To try a local tarball manually:

```sh
node packages/cli/bin/cli.mjs init javascript,python /tmp/my-sandbox
cd /tmp/my-sandbox
pnpm add /absolute/path/to/dist/sandbox-workers-javascript-<version>.tgz /absolute/path/to/dist/sandbox-workers-python-<version>.tgz
pnpm run dry-run
```

## Release

Releases are automated with [tagpr](https://github.com/Songmu/tagpr), configured in `.tagpr`. Every pull request merged to `main` may carry a `minor` or `major` label; a PR with neither label produces a patch release.

1. Merge pull requests as usual, adding a `minor` or `major` label when a change should bump beyond a patch. tagpr keeps a "Release vX.Y.Z" pull request open and up to date, bumping the version across all six `packages/*/package.json` files and each runtime's `src/metadata.ts`, and updating `CHANGELOG.md`.
2. Review the open release pull request: check `CHANGELOG.md`, the bumped version files, and — for any runtime whose engine changed — that runtime's `THIRD_PARTY_NOTICES.md`.
3. Merge the release pull request. `.github/workflows/release.yml` rebuilds and validates the merge commit (`build:languages`, `build:packages`, `check`, `test`, `scripts/pack.mjs`, `test:package`), tags `vX.Y.Z`, creates a GitHub Release with the six tarballs attached, and publishes `@sandbox-workers/{core,javascript,python,perl,ruby,cli}` to npm using npm trusted publishing (OIDC; no long-lived npm token is stored).

Deploy the Playground separately with `pnpm run deploy:engines`, followed by `pnpm run deploy:gateway`. Updating an npm dependency does not update a running Worker until the consumer redeploys it.

## Continuous integration

`.github/workflows/ci.yml` runs the full build, tests, packaging, and package tests on every pull request, caching the downloaded and instrumented engines so runs stay fast.

## Add another runtime

Create `packages/<language>` with an independent Worker, Wasm engine, and metadata export, published as `@sandbox-workers/<language>`. Keep the shared JSON contract in core and language-specific engines, dependencies, and limits in their runtime packages. Register it in the shared CLI, then add a Service Binding, registry entry, editor extension, and examples to the Playground.

[JavaScript architecture](docs/runtime.md) · [Language runtimes](docs/languages.md) · [JavaScript package](packages/javascript/README.md) · [Shared client](packages/core/README.md)

## License

Original sandbox-workers code is licensed under the [MIT License](LICENSE), copyright (c) 2026 syumai. Bundled interpreters and third-party components retain their upstream licenses; see each runtime package's `THIRD_PARTY_NOTICES.md` and `licenses/` directory.
