---
title: JavaScript
description: Execute code with SpiderMonkey / Fastly 3.45.0 inside a dedicated Wasm Worker.
---

Package: `@sandbox-workers/javascript`. Supports async function bodies, promises, modern JavaScript syntax, and selected Fastly Web builtins. ES modules, Node/npm resolution, timers, and networking are unavailable. BigInt results become strings ending in n.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript)

Or, after npm publication:

```sh
pnpm dlx @sandbox-workers/cli init javascript my-sandbox
```

See [deployment setup](/getting-started/deploy) and [Service Bindings](/guides/service-bindings). The template requires a Paid plan and creates no public URL.

## Example

Input:

```json
{ "name": "world" }
```

Code:

```javascript
const name = input?.name ?? "world";
console.log(`Hello, ${name}!`);
return {
  greeting: `Hello, ${name}!`,
  engine: "SpiderMonkey inside WebAssembly",
};
```

Every request gets a fresh engine instance. State does not persist between executions. Consult [limits](/reference/limits) for fuel, memory, and output budgets.

## License notice

Before use or redistribution, review this runtime's [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/javascript/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/javascript/THIRD_PARTY_NOTICES.md). Bundled interpreters retain their upstream licenses. The package includes the applicable notices in its `licenses/` directory.
