---
title: Bindings
description: Runtime Service Bindings for stateless mode, and the Sandbox Durable Object binding plus binding-name rules for stateful mode.
---

There are two kinds of binding in this system, on two different Workers: the runtime Service Bindings that both modes use, and the `Sandbox` Durable Object binding that stateful mode adds.

## Stateless mode: runtime Service Bindings only

Each runtime Worker is bound by the **name of a Service Binding** in your own environment — there is no `language` option anywhere:

```jsonc
{
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "JAVASCRIPT", "service": "sandbox-javascript" },
  ],
}
```

```ts
import { runCode } from "@sandbox-workers/core";

const result = await runCode(env.PYTHON, code);
```

You choose the binding names — `PYTHON` and `JAVASCRIPT` above are just names in your own `env`, not fixed identifiers. This requires only the `services` entry above; no `durable_objects`/`migrations` block on your side.

## Stateful mode: the `Sandbox` binding plus runtime Service Bindings

### The `Sandbox` Durable Object binding

Your own Worker hosts the `Sandbox` class (from `@sandbox-workers/core`) and binds it with `durable_objects`:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
}
```

```ts
export { Sandbox } from "@sandbox-workers/core";
```

`getSandbox(env.Sandbox, id)` requires this to be a real Durable Object namespace bound to that class — it throws synchronously otherwise (a plain `Error`, not a `SandboxError`), naming the class and package to export. There is no Service Binding transport for `getSandbox` any more: a `Sandbox` only ever exists inside your own Worker.

### Runtime Service Bindings

Each code context is bound to a runtime Worker by the same kind of Service Binding name used in stateless mode:

```jsonc
{
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "JAVASCRIPT", "service": "sandbox-javascript" },
  ],
}
```

```ts
const py = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });
```

One sandbox can hold contexts across several bindings at once, all sharing the sandbox's single `/workspace`. The same binding names also work with the free, stateless `runCode(env.PYTHON, code)` function, which talks to the runtime Worker directly with no `Sandbox` involved at all.

### Name rules and validation

A binding name must match `/^[A-Za-z_][A-Za-z0-9_]*$/`. Beyond that, `createCodeContext({ binding })` (and default-context resolution for `runCode({ binding })`) probes the binding before using it:

1. **`env[binding]` must exist and have a `fetch` method** — this excludes the `Sandbox` namespace itself and every non-Fetcher value. Otherwise: `ValidationFailedError`, "Unknown binding 'X'".
2. **`GET /interpreter` on it must return `{ language, engine, contexts }`** — otherwise: `ValidationFailedError`, "Binding 'X' is not a sandbox-workers runtime Worker".
3. **`contexts` must be `true`** — a stateless-only runtime Worker (deployed `--stateless`, or Ruby) always reports `false`. Otherwise: `ValidationFailedError`, "Code contexts are not supported by binding 'X' (language)".

This probe runs only on `createCodeContext` and default-context creation, never on every execution — see [Errors](/api/errors#binding-validation-errors) for the exact messages.

## Related resources

- [Wrangler configuration](/configuration/wrangler) — full caller and runtime Worker configuration.
- [Lifecycle](/api/lifecycle) — `getSandbox()` and sandbox id rules.
- [Code interpreter](/api/interpreter) — `createCodeContext()` and the free `runCode()`.
