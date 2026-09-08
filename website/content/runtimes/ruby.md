---
title: Ruby
description: Execute code with CRuby 4.0.0 (ruby.wasm 2.10.1) inside a dedicated Wasm Worker.
---

Package: `@sandbox-workers/ruby`. Code is a script: the value of the last expression is the result. Supports Enumerable and the bundled standard library. The JavaScript bridge is disabled. gem installation and arbitrary native extensions are unavailable.

Engine: CRuby 4.0.0 compiled to Wasm by [ruby.wasm](https://github.com/ruby/ruby.wasm) 2.10.1 (`@ruby/4.0-wasm-wasi`).

**Ruby is stateless-only** — its runtime Worker always answers `contexts: false`, so it works in [stateless mode](/stateless) only; see [Code contexts](/concepts/code-contexts) for why.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)

Or, with the CLI:

```sh
pnpm dlx @sandbox-workers/cli init ruby my-sandbox
```

See [deployment setup](/deploy) and [Service Bindings](/configuration/wrangler). The template requires a Paid plan and creates no public URL.

## Example

Env vars:

```json
{ "NAME": "world" }
```

Code:

```ruby
name = ENV.fetch("NAME", "world")
puts "Hello from Ruby!"
{message: "Hello, #{name}!", squares: (0..5).map { |x| x*x }}
```

Every request gets a fresh engine instance. State does not persist between executions. Consult [limits](/platform/limits) for fuel, memory, and output budgets.

## License notice

Before use or redistribution, review this runtime's [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/ruby/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/ruby/THIRD_PARTY_NOTICES.md). Bundled interpreters retain their upstream licenses. The package includes the applicable notices in its `licenses/` directory.
