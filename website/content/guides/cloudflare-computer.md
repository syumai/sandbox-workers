---
title: Cloudflare Computer
description: Persist files in Computer and execute code through sandbox-workers Service Bindings.
---

## A persistent workspace with four languages

The [Cloudflare Computer example](https://github.com/syumai/sandbox-workers/tree/main/examples/cloudflare-computer) stores input, code, and results in a SQLite-backed Durable Object using `@cloudflare/computer` 0.2.1. Private Service Bindings send execution to JavaScript, Python, Perl, or Ruby.

Computer handles persistence; sandbox-workers handles guest execution. This example bridges selected file contents as JSON. It does not mount Computer's filesystem inside the interpreters or register a `workspace.runtime.exec()` backend.

## Run locally

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec wrangler dev -c examples/cloudflare-computer/wrangler.jsonc -c engine/wrangler.jsonc -c engine/wrangler-python.jsonc -c engine/wrangler-perl.jsonc -c engine/wrangler-ruby.jsonc
```

Use the example URL printed by Wrangler:

```sh
curl -X POST 'http://localhost:8787/demo?language=python'
```

Choose `javascript`, `python`, `perl`, or `ruby`. Each returns an `execution` envelope whose `result` is `{ "total": 3400, "count": 2 }`. The fixed basket is written to `/input.json`, the selected program to `/program.txt`, and the full response to `/result.json`.

## Deploy

Build first, then deploy the engine services and example:

```sh
pnpm run deploy:engines
pnpm --filter @sandbox-workers/example-cloudflare-computer run deploy
```

The example creates `sandbox-computer-example` with a SQLite Durable Object namespace. Its four Service Bindings target the repository's `sandbox-engine-*` Workers in the same account. Adjust the names if you used different templates. Workers Paid is required for the configured engine CPU limits; Worker and Durable Object usage incurs account usage charges.

## Adapt it to your agent

The host uses this sequence inside the Durable Object:

```ts
await workspace.fs.writeFile("/input.json", JSON.stringify(data));
const execution = await createSandbox(env.PYTHON, "python").execute({
  code: await workspace.fs.readFile("/program.txt", "utf8"),
  input: JSON.parse(await workspace.fs.readFile("/input.json", "utf8")),
});
await workspace.fs.writeFile("/result.json", JSON.stringify(execution));
```

Guest code receives only the JSON selected by the host. It cannot directly read the workspace, make network calls, or use the host's bindings. Validate guest results before turning them into file writes or other actions.

The public example runs only fixed programs and fixtures, overwrites three bounded files, and serializes each language's executions. It accepts no uploaded files or request-body input. For a multi-user agent, authenticate requests and select a workspace per authorized user before accepting private data or persistent writes.

Computer is a preview API, pinned here to 0.2.1. This example needs no container, Worker Loader, or AI provider key. See [upstream documentation](https://github.com/cloudflare/computer/tree/main/docs) for Computer's other execution backends.

## Licenses

Example and adapter code is MIT licensed by syumai. Computer has its own MIT license. Each interpreter retains its own upstream terms: review the runtime's **LICENSE**, **THIRD_PARTY_NOTICES.md**, and bundled licenses before use or redistribution. See [Licenses](/reference/licenses) and the individual [runtime pages](/runtimes/javascript).
