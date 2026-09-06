---
title: Use code contexts
description: Keep state between executions with a durable, stateful REPL.
---

`runCode` without a context boots a fresh Wasm instance on every call: nothing persists. A **code context** is the stateful alternative — a named, durable REPL that keeps a language interpreter's globals alive between executions. This guide shows you how to create one, run code in it, and manage its lifecycle with the typed `@sandbox-workers/core` client.

Code contexts are supported for **JavaScript, Python, and Perl**. **Ruby is not supported** — code contexts require the memory-snapshot mechanism the other languages use, which Ruby's engine does not support.

## Create a context

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.SANDBOX, "user-42");

const ctx = await sandbox.createCodeContext({
  language: "python",
  cwd: "/workspace",
  envVars: { MODE: "test" },
});
```

## Run code in a context

```ts
await sandbox.runCode("count = 1", { context: ctx });
const result = await sandbox.runCode("count += 1\ncount", { context: ctx });
// result.results[0].text === "2"
```

One execution's top-level variables, functions, classes, and imported modules are visible to the next execution in the same context. `/workspace` is shared by every context in the sandbox, so files written from one context are visible from another. See [Manage files](/guides/manage-files) for the files API.

`sandbox.runCode` resolves to the same `ExecutionResult` shape whether or not a `context` is passed, plus a `context: {id, cwd, executions, snapshotMs?, expiresAt?}` field when running in a context, and — like stateless execution — always resolves rather than throwing for a guest error; check `result.error`. See [the interpreter API reference](/api/interpreter) for the full signature and result shape, and [Memory snapshots](/concepts/code-contexts#memory-snapshots) for how a context's state survives Durable Object eviction, hibernation, and redeploys.

## Use the default context

```ts
// Default context for the runtime's language, created on first use:
await sandbox.runCode("import os\nos.environ['X']", { envVars: { X: "12" } });
```

`runCode` without a context uses (or creates) the first context whose language matches the request, so simple callers never need to think about contexts at all.

## Update environment variables

```ts
await sandbox.setEnvVars({ NAME: "value", OLD: undefined }); // undefined unsets a key
```

## List and delete contexts

```ts
await sandbox.listCodeContexts();
await sandbox.deleteCodeContext(ctx.id);
```

A sandbox holds at most 8 code contexts, with one interpreter resident in memory at a time; the rest are restored from their snapshot on next use. Deleting a context drops both the live interpreter and its stored snapshot; `/workspace` is untouched, since it belongs to the sandbox rather than the context.

## REPL semantics per language

### JavaScript

Code runs as a classic script in the context's realm, so top-level `var`, `let`, `const`, `class`, and `function` declarations persist across executions exactly as in a browser console — the completion value of the script is still the result. A top-level `await` is hoisted the way Node's REPL does it, so values assigned that way persist too.

`process.env` is rebuilt from the layered env vars before every execution. `process.cwd()` and `process.chdir(path)` are host functions backed by the sandbox's workspace; `chdir` is validated against `/workspace`.

### Python

Code runs with `exec` in a persistent `__main__` namespace. If the last statement is an expression, its value is the result. `os.chdir(cwd)` runs before the body, and the final `os.getcwd()` is persisted when it is under `/workspace`. `sys.path` includes `/workspace`, so modules written there can be imported by a later execution in the same context.

### Perl

Code runs with `eval` in package `main`. Package variables declared `our`, subroutines, and loaded modules persist across executions; `my` variables are lexically scoped to the one execution that declared them and do not survive to the next. `chdir($cwd)` runs before the body and `Cwd::getcwd()` is persisted afterward.
