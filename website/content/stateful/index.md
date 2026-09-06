---
title: Stateful mode
description: Host a Sandbox Durable Object in your own Worker for code contexts, a shared workspace, and state that persists between calls.
---

**Stateful mode** hosts a `Sandbox` Durable Object in your own Worker (`export { Sandbox } from "@sandbox-workers/core"`). `getSandbox(env.Sandbox, id)` gets you a typed client for one sandbox, which owns a shared `/workspace` and one or more **code contexts** — durable REPLs, each bound to a runtime Worker by the name of a Service Binding, that keep a language interpreter's globals alive between executions.

```ts
import { getSandbox } from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.Sandbox, "user-42");
const ctx = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });

await sandbox.interpreter.runCode("count = 1", { context: ctx });
await sandbox.interpreter.runCode("count += 1\ncount", { context: ctx });
// result.results[0].text === "2"
```

## What you need

A deployed runtime Worker, plus in your own `wrangler.jsonc`: a `services` entry, a `durable_objects` binding for `Sandbox`, its migration, and `export { Sandbox } from "@sandbox-workers/core"` in your entry point.

## What you get

Persistent globals per code context (top-level variables, functions, classes, imports), a shared `/workspace` that every context in the sandbox can read and write regardless of language, a files API from the caller side, `sandbox.setEnvVars()`, and configurable idle expiry.

## What you can't do

There is no process execution, no terminals, and no ports — see [Architecture](/concepts/architecture) for the full scope of what this project doesn't implement.

## Languages

Code contexts are supported for JavaScript, Python, and Perl. **Ruby is stateless-only** — its runtime Worker always answers `contexts: false`. A runtime Worker deployed with the CLI's `--stateless` flag reports the same thing, regardless of language. Against either, `createCodeContext({ binding })` fails with `ValidationFailedError`, and `sandbox.interpreter.runCode(code, { binding })` (no `context`) falls back to running statelessly instead.

## When to choose it

Choose stateful mode when you need variables, functions, or imports to survive between calls, or when you need a shared `/workspace` — for one language or several at once.

## In this section

- [Get started with stateful mode](/stateful/get-started): host a `Sandbox` Durable Object and run your first code context.
- [Use code contexts](/stateful/code-contexts): create, run in, list, and delete code contexts, and use several languages in one sandbox.
- [Manage files](/stateful/manage-files): read and write files under `/workspace`.

## Related resources

- [API: Lifecycle](/api/lifecycle)
- [API: Code interpreter](/api/interpreter)
- [API: Files](/api/files)
- [Sandbox lifecycle](/concepts/sandboxes)
- [Code contexts](/concepts/code-contexts)
- [Configuration: wrangler.jsonc](/configuration/wrangler)
