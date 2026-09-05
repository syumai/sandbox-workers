# Cloudflare Computer + sandbox-workers

This example uses `@cloudflare/computer` 0.2.1 to keep code, env vars, and execution results in a Durable Object's SQLite filesystem. JavaScript, Python, Perl, and Ruby execute in separate sandbox-workers through private Service Bindings.

## Run from this repository

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec wrangler dev -c examples/cloudflare-computer/wrangler.jsonc -c engine/wrangler.jsonc -c engine/wrangler-python.jsonc -c engine/wrangler-perl.jsonc -c engine/wrangler-ruby.jsonc
```

Use the example Worker's URL printed by Wrangler:

```sh
curl -X POST 'http://localhost:8787/demo?language=python'
```

Change `python` to `javascript`, `perl`, or `ruby`. Each computes `{ "total": 3400, "count": 2 }` from the same shopping basket. The response includes the execution envelope and the paths used in Computer. `GET /` describes the endpoint.

## Deploy

From the repository root, after building:

```sh
pnpm run deploy:engines
pnpm --filter @sandbox-workers/example-cloudflare-computer run deploy
```

This creates `sandbox-computer-example` and a SQLite Durable Object namespace. The four engine Workers must exist in the same Cloudflare account; edit the Service Binding names if you deployed them under different names. Workers Paid is required for the configured engine CPU limits. Cloudflare execution and Durable Object storage usage is billed to your account.

## Verify all four runtimes

```sh
COMPUTER_URL=https://your-example.workers.dev pnpm --filter @sandbox-workers/example-cloudflare-computer test:http
```

This checks each persisted execution result plus unsupported-language and method handling.

## How it works

1. The HTTP Worker selects one of four fixed demo Durable Objects, one per language.
2. Computer writes `/input.json` and `/program.txt` to SQLite.
3. The host reads those files and calls `createSandbox(binding).runCode(code, { envVars })`.
4. The host saves the full execution envelope as `/result.json` and reads it back into the response.

The fixed fixture and filenames keep this public demo's storage bounded. Each object's read/execute/write cycle is serialized. No credentials or user files are stored. Request bodies are not used: edit the fixture and language programs in `src/index.ts` to change the example.

This is an explicit JSON bridge, not a mounted filesystem or a `workspace.runtime.exec()` backend. Guest programs cannot access Computer's filesystem, Service Bindings, or network directly. If you extend this into an agent, pass selected file contents as input and validate its result before writing it back. Bind workspaces to authenticated users before accepting private files or arbitrary persistent writes. The public Playground separately supports arbitrary guest code.

Computer is a preview API; its version is pinned. No container, Docker, Worker Loader, AI provider, or model key is required by this example.

## Licenses

The example code is covered by the repository's [MIT LICENSE](../../LICENSE), copyright syumai. Cloudflare Computer is MIT licensed; retain its [upstream LICENSE](https://github.com/cloudflare/computer/blob/main/LICENSE).

Before using or redistributing a runtime, review that package's **LICENSE**, **THIRD_PARTY_NOTICES.md**, and bundled upstream license files:

- [JavaScript](../../packages/javascript/README.md): SpiderMonkey, goccy/spidermonkey-wasm, and related dependencies.
- [Python](../../packages/python/README.md): CPython and bundled standard library/dependencies.
- [Perl](../../packages/perl/README.md): Perl and its bundled distribution.
- [Ruby](../../packages/ruby/README.md): Ruby, ruby.wasm, and bundled dependencies.

The adapters' MIT license does not replace those upstream licenses. See the documentation's [license reference](../../website/content/reference/licenses.md).
