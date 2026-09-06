---
title: Stateless mode
description: Call a runtime Worker's Service Binding directly with the free runCode function — no sandbox, no code context, no files.
---

**Stateless mode** is the simplest way to run guest code: your Worker calls a runtime Worker's Service Binding directly with the free `runCode(env.PYTHON, code)` function from `@sandbox-workers/core`. There is no `Sandbox` Durable Object, no code context, and no `/workspace` — every call boots a fresh Wasm instance.

```ts
import { runCode } from "@sandbox-workers/core";

const result = await runCode(env.PYTHON, "1 + 1"); // env.PYTHON: a Service Binding to the runtime Worker
```

## What you need

A deployed runtime Worker and a `services` entry in your own `wrangler.jsonc` — nothing else:

```jsonc
{
  "services": [{ "binding": "PYTHON", "service": "sandbox-python" }],
}
```

No `durable_objects` binding, no migration, and no `export { Sandbox }` in your entry point.

## What you get

A fresh Wasm instance per call, `envVars` passed into the guest, and a resolved `ExecutionResult` (`results`, `logs`, and `error`). Every language works in stateless mode, including Ruby.

## What you don't get

No state between calls, no files, no `/workspace`, and no `getSandbox` — top-level variables, functions, and imports from one call are gone by the next.

## When to choose it

Choose stateless mode when a call is self-contained: a single expression to evaluate, a transformation with no need to remember anything from a previous request. It is also the only mode a stateless-only runtime Worker (Ruby, or one deployed with the CLI's `--stateless` flag) supports.

You can switch to [stateful mode](/stateful) later against the same runtime Worker and the same binding names — deploying a runtime Worker doesn't commit you to one mode or the other.

## In this section

- [Get started with stateless mode](/stateless/get-started): deploy a runtime Worker and call it with the free `runCode`.
- [Execute code](/stateless/execute-code): read `results`, `logs`, and `error`, and use one binding per runtime for multiple languages.

## Related resources

- [API: the free `runCode()` function](/api/interpreter#runcode-free-function-stateless-mode)
- [API: Errors](/api/errors)
- [Configuration: Bindings](/configuration/bindings)
- [Security model](/concepts/security)
- [Deploy a runtime Worker](/deploy)
