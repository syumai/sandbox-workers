---
title: Python
description: Execute code with CPython 3.14.6 (goccy/python-wasm v0.2.0) inside a dedicated Wasm Worker.
---

Package: `@sandbox-workers/python`. Includes a read-only standard library. This build cannot use _decimal, decimal, fractions, or statistics because mpdecimal imports are unresolved. pip installations and native extensions are unavailable.

Engine: CPython 3.14.6 compiled to Wasm by [goccy/python-wasm](https://github.com/goccy/python-wasm) v0.2.0.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fpython)

Or, with the CLI:

```sh
pnpm dlx @sandbox-workers/cli init python my-sandbox
```

See [deployment setup](/deploy) and [Service Bindings](/configuration/wrangler). The template requires a Paid plan and creates no public URL.

## Example

Env vars:

```json
{ "NAME": "world" }
```

Code:

```python
import os
name = os.environ.get("NAME", "world")
print("Hello from CPython!")
{"message": f"Hello, {name}!", "squares": [x*x for x in range(6)]}
```

Every request gets a fresh engine instance. State does not persist between executions. Consult [limits](/platform/limits) for fuel, memory, and output budgets.

## License notice

Before use or redistribution, review this runtime's [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/python/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/python/THIRD_PARTY_NOTICES.md). Bundled interpreters retain their upstream licenses. The package includes the applicable notices in its `licenses/` directory.
