---
title: Overview
description: Run a code interpreter on your own Cloudflare account in stateless or stateful mode, in the shape of the Sandbox SDK 1.0 preview.
---

sandbox-workers deploys JavaScript, Python, Perl, and Ruby interpreters as separate Wasm Workers on your own Cloudflare account. You can call a runtime Worker directly for one-shot execution (**stateless mode**), or host a `Sandbox` Durable Object in **your own** Worker that mirrors the [Sandbox SDK 1.0 preview](https://developers.cloudflare.com/sandbox/1-0-preview/)'s model: `getSandbox(env.Sandbox, id)`, `sandbox.interpreter.*`, and a shared `/workspace` (**stateful mode**). Every code context and every stateless call is bound to a runtime Worker by the **name of a Service Binding** — there is no `language` option — so one sandbox can run several languages at once, all sharing the same files.

There is no process execution, terminals, ports, or backups here: this project runs one thing, a code interpreter, on Wasm rather than containers. See [Concepts](/concepts) for what that trades away and [the design document](https://github.com/syumai/sandbox-workers/blob/main/docs/sandbox-1-0-design.md) for the full model.

## Two modes

|                       | Stateless mode                                              | Stateful mode                                                        |
| --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| What runs on your side | Nothing extra — you call the runtime Worker directly        | A `Sandbox` Durable Object, hosted in your own Worker                 |
| State between calls    | None — a fresh Wasm instance every call                     | Persists in a code context: top-level variables, functions, imports  |
| Files                  | None                                                          | A shared `/workspace`, readable and writable by every code context    |
| Languages              | JavaScript, Python, Perl, and Ruby                            | JavaScript, Python, and Perl (Ruby is stateless-only)                 |
| Setup                  | A `services` entry only                                      | `services` + `durable_objects` binding + migration + `export { Sandbox }` |
| Client call            | `runCode(env.PYTHON, code)`                                  | `getSandbox(env.Sandbox, id).interpreter.runCode(code, { context })`  |

- **Choose stateless when** you need a one-shot, isolated execution and don't need state or files to survive between calls.
- **Choose stateful when** you need variables, functions, or imports to persist across calls, or you need a shared `/workspace` across one or more languages.

You can mix both against the same runtime Worker and the same binding names — a Worker deployed once serves either call shape. A stateless-only runtime Worker (Ruby, or one scaffolded with the CLI's `--stateless` flag) only supports stateless mode: it works normally with the free `runCode`, but `createCodeContext({ binding })` against it fails, and `sandbox.interpreter.runCode(code, { binding })` (no `context`) falls back to running statelessly.

## Examples

### Stateless mode: one call, no sandbox

```ts
import { runCode } from "@sandbox-workers/core";

const result = await runCode(env.PYTHON, "1 + 1"); // env.PYTHON: a Service Binding to the runtime Worker
```

For a one-shot call with no code context and no files, call the free `runCode` function directly against a runtime Worker's Service Binding — no `Sandbox` Durable Object involved.

### Stateful mode

#### Execute code in a context

```ts
import { getSandbox } from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

export default {
  async fetch(request, env) {
    const sandbox = getSandbox(env.Sandbox, "user-42");
    const ctx = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });
    const result = await sandbox.interpreter.runCode(
      "print('Hello!')\nimport os\nint(os.environ['X']) ** 2",
      { context: ctx, envVars: { X: "12" } },
    );
    return Response.json(result);
  },
};
```

`runCode` always resolves to an `ExecutionResult`: no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`.

#### Multiple languages, one workspace

```ts
const sandbox = getSandbox(env.Sandbox, "user-42");

const py = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });
const js = await sandbox.interpreter.createCodeContext({ binding: "JAVASCRIPT" });

await sandbox.interpreter.runCode("open('/workspace/a.txt','w').write('hi')", { context: py });
await sandbox.interpreter.runCode("fs.readFileSync('/workspace/a.txt','utf8')", { context: js });
```

A code context is a durable REPL bound to one runtime Worker: top-level variables, functions, classes, and imported modules from one execution are visible to the next execution in the same context. `/workspace` belongs to the sandbox, not to any one context, so a JavaScript context can read a file a Python context wrote.

#### Files

```ts
const sandbox = getSandbox(env.Sandbox, "user-42");

await sandbox.mkdir("/workspace/project", { recursive: true });
await sandbox.writeFile("/workspace/project/app.py", "print('hi')");
const file = await sandbox.readFile("/workspace/project/app.py");
```

Every sandbox owns a writable `/workspace` directory, reachable from guest code and from the caller through a files API, and shared by every code context in that sandbox regardless of language.

## Choose an engine

| Runtime                            | Engine                       | Env vars accessed as |
| ----------------------------------- | ---------------------------- | --------------------- |
| [JavaScript](/runtimes/javascript) | SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6 | `process.env.NAME`    |
| [Python](/runtimes/python)         | CPython 3.14.6               | `os.environ["NAME"]`  |
| [Perl](/runtimes/perl)             | Perl 5.42.2                  | `$ENV{NAME}`          |
| [Ruby](/runtimes/ruby)             | CRuby 4.0.0                  | `ENV["NAME"]`         |

Every run creates a fresh Wasm instance unless it runs in a code context. Fuel, memory, and output bounds limit guest execution. Standard libraries depend on the selected engine; host networking, host files, and package installation are unavailable. **Ruby is stateless-only** — its runtime Worker always answers `contexts: false`, so it works in stateless mode only.

## Start here

- [Deploy a runtime Worker](/deploy): create a private runtime Worker with a deploy button or the CLI.
- [Get started with stateless mode](/stateless/get-started): call a runtime Worker's Service Binding directly.
- [Get started with stateful mode](/stateful/get-started): host a `Sandbox` Durable Object and run your first code context.

## Explore

- [Stateless mode](/stateless): one-shot execution with no sandbox.
- [Stateful mode](/stateful): code contexts and a shared `/workspace`.
- [API reference](/api): request fields, responses, and error handling.
- [Concepts](/concepts): architecture, sandbox lifecycle, code contexts, runtime engines, and security model.
- [Configuration](/configuration): the caller's and runtime Worker's `wrangler.jsonc`, bindings, and environment variables.
- [Runtimes](/runtimes/javascript): per-language details for JavaScript, Python, Perl, and Ruby.
- [Platform](/platform): limits, licenses, and troubleshooting.

The npm packages are currently previews and have not been published. Source-based deployment templates work independently of npm publication once this repository and the template directories are public. Read [runtime licenses](/platform/licenses) and [limits](/platform/limits) before use.
