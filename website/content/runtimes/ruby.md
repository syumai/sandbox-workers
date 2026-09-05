---
title: Ruby
description: Execute code with CRuby 4.0.0 inside a dedicated Wasm Worker.
---

Package: `@sandbox-workers/ruby`. Supports Ruby function bodies, Enumerable, and the bundled standard library. The JavaScript bridge is disabled. gem installation and arbitrary native extensions are unavailable.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)

Or, after npm publication:

```sh
pnpm dlx @sandbox-workers/cli init ruby my-sandbox
```

See [deployment setup](/getting-started/deploy) and [Service Bindings](/guides/service-bindings). The template requires a Paid plan and creates no public URL.

## Example

Input:

```json
{ "name": "world" }
```

Code:

```ruby
puts "Hello from Ruby!"
return {message: "Hello, #{input['name']}!", squares: (0..5).map { |x| x*x }}
```

Every request gets a fresh engine instance. State does not persist between executions. Consult [limits](/reference/limits) for fuel, memory, and output budgets.

## License notice

Before use or redistribution, review this runtime's [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/ruby/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/ruby/THIRD_PARTY_NOTICES.md). Bundled interpreters retain their upstream licenses. The package includes the applicable notices in its `licenses/` directory.
