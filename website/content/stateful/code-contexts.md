---
title: Use code contexts
description: Keep state between executions with a durable, stateful REPL bound to a runtime Worker.
---

This is the **stateful mode** guide. For the other mode — a one-shot call with no sandbox — see [Stateless mode](/stateless): its free `runCode` function boots a fresh Wasm instance on every call, and nothing persists. A **code context** is stateful mode's building block — a named, durable REPL, bound to one runtime Worker, that keeps a language interpreter's globals alive between executions. This guide shows you how to create one, run code in it, and manage its lifecycle with the typed `@sandbox-workers/core` client.

Code contexts live inside a `Sandbox` Durable Object hosted by **your own** Worker (`export { Sandbox } from "@sandbox-workers/core"`) — see [Get started with stateful mode](/stateful/get-started) for the binding and migration. Each context is bound to a runtime Worker by the **name of a Service Binding** in your own environment; there is no `language` option. One sandbox can hold contexts of several languages at once, all sharing the sandbox's single `/workspace`.

Code contexts are supported for **JavaScript, Python, and Perl**. **Ruby is not supported** — code contexts require the memory-snapshot mechanism the other languages use, which Ruby's engine does not support. A stateless-only runtime Worker: Ruby, or one deployed with the CLI's `--stateless` flag, reports the same `contexts: false`.

## Create a context

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.Sandbox, "user-42");

const ctx = await sandbox.interpreter.createCodeContext({
  binding: "PYTHON",
  cwd: "/workspace",
  envVars: { MODE: "test" },
});
```

`binding` must name a Service Binding in your own environment to a sandbox-workers runtime Worker; an unknown or non-runtime binding fails with `ValidationFailedError` (`VALIDATION_FAILED`), and a binding that reports `contexts: false` (a stateless-only runtime Worker: Ruby, or one deployed with `--stateless`) fails with the same error naming the binding and its language. [`getSandbox<Env>()`](/api/lifecycle#getsandbox) checks this at compile time instead of runtime: pass your Worker's `Env` type and a misspelled `binding` fails to build.

## Run code in a context

```ts
await sandbox.interpreter.runCode("count = 1", { context: ctx });
const result = await sandbox.interpreter.runCode("count += 1\ncount", { context: ctx });
// result.results[0].text === "2"
```

One execution's top-level variables, functions, classes, and imported modules are visible to the next execution in the same context. `/workspace` is shared by every context in the sandbox, regardless of binding — so a file written by a Python context is visible to a JavaScript one. See [Manage files](/stateful/manage-files) for the files API.

`sandbox.interpreter.runCode` resolves to an `ExecutionResult` with a `context: {id, cwd, executions, snapshotMs?, expiresAt?}` field when it ran in a context, and — like the stateless `runCode` — always resolves rather than throwing for a guest error; check `result.error`. See [the interpreter API reference](/api/interpreter) for the full signature and result shape, and [Memory snapshots](/concepts/code-contexts#memory-snapshots) for how a context's state survives Durable Object eviction, hibernation, and redeploys.

## Multiple languages, one workspace

```ts
const py = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });
const js = await sandbox.interpreter.createCodeContext({ binding: "JAVASCRIPT" });

await sandbox.interpreter.runCode("open('/workspace/shared.txt','w').write('hi')", { context: py });
await sandbox.interpreter.runCode("fs.readFileSync('/workspace/shared.txt','utf8')", { context: js });
// "hi"
```

Each context keeps its own globals, but `/workspace` belongs to the sandbox, not to any single context — every binding's interpreter mirrors the same files on demand.

## Use the default context

```ts
// Default context for the PYTHON binding, created on first use:
await sandbox.interpreter.runCode("import os\nos.environ['X']", {
  binding: "PYTHON",
  envVars: { X: "12" },
});
```

`runCode` without a `context` requires `binding` and uses (or creates) the oldest existing context for that binding, so simple callers never need to think about contexts at all. Passing neither `context` nor `binding` fails with `ValidationFailedError` ("Pass a context or a binding").

## Update environment variables

```ts
await sandbox.setEnvVars({ NAME: "value", OLD: undefined }); // undefined unsets a key
```

`setEnvVars` is layered onto every context in the sandbox, regardless of binding. See [Environment variables](/configuration/environment-variables) for the full layering order.

## List and delete contexts

```ts
await sandbox.interpreter.listCodeContexts();
await sandbox.interpreter.deleteCodeContext(ctx.id);
```

A sandbox holds at most 8 code contexts across all bindings, with one interpreter resident in memory per runtime Worker; the rest are restored from their snapshot on next use. Deleting a context drops both the live interpreter and its stored snapshot; `/workspace` is untouched, since it belongs to the sandbox rather than the context.

## REPL semantics per language

### JavaScript

Code runs as a classic script in the context's realm, so top-level `var`, `let`, `const`, `class`, and `function` declarations persist across executions exactly as in a browser console — the completion value of the script is still the result. A top-level `await` is hoisted the way Node's REPL does it, so values assigned that way persist too.

`process.env` is rebuilt from the layered env vars before every execution. `process.cwd()` and `process.chdir(path)` are host functions backed by the sandbox's workspace; `chdir` is validated against `/workspace`.

### Python

Code runs with `exec` in a persistent `__main__` namespace. If the last statement is an expression, its value is the result. `os.chdir(cwd)` runs before the body, and the final `os.getcwd()` is persisted when it is under `/workspace`. `sys.path` includes `/workspace`, so modules written there can be imported by a later execution in the same context.

### Perl

Code runs with `eval` in package `main`. Package variables declared `our`, subroutines, and loaded modules persist across executions; `my` variables are lexically scoped to the one execution that declared them and do not survive to the next. `chdir($cwd)` runs before the body and `Cwd::getcwd()` is persisted afterward.
