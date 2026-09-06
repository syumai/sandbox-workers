---
title: Overview
description: Run code in isolated language engines on your own Cloudflare account.
---

sandbox-workers packages JavaScript, Python, Perl, and Ruby interpreters as separate Wasm Workers, deployed to your own Cloudflare account. Your application talks to a runtime Worker over a Service Binding: it sends a code script and string env vars and reads back the value of the last expression, captured output, and any error. Stateless execution boots a fresh Wasm instance on every call; an optional stateful mode adds durable, named code contexts and a shared `/workspace` for files.

## Examples

### Execute code

```ts
import { getSandbox } from "@sandbox-workers/core";

export default {
  async fetch(request, env) {
    const sandbox = getSandbox(env.SANDBOX, "user-42");
    const result = await sandbox.runCode(
      "print('Hello!')\nimport os\nint(os.environ['X']) ** 2",
      { envVars: { X: "12" } },
    );
    return Response.json(result);
  },
};
```

`runCode` always resolves to an `ExecutionResult`: no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`.

### Code contexts

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.SANDBOX, "user-42");

const ctx = await sandbox.createCodeContext({ language: "python" });
await sandbox.runCode("data = [1, 2, 3]", { context: ctx });
const result = await sandbox.runCode("sum(data)", { context: ctx });
// result.results[0].text === "6"
```

A code context is a durable REPL: top-level variables, functions, classes, and imported modules from one execution are visible to the next execution in the same context.

### Files

```ts
const sandbox = getSandbox(env.SANDBOX, "user-42");

await sandbox.mkdir("/workspace/project", { recursive: true });
await sandbox.writeFile("/workspace/project/app.py", "print('hi')");
const file = await sandbox.readFile("/workspace/project/app.py");
```

Every sandbox owns a writable `/workspace` directory, reachable from guest code and from the caller through a files API, and shared by every code context in that sandbox.

## Choose an engine

| Runtime                            | Engine                       | Env vars accessed as |
| ---------------------------------- | ---------------------------- | --------------------- |
| [JavaScript](/runtimes/javascript) | SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6 | `process.env.NAME`    |
| [Python](/runtimes/python)         | CPython 3.14.6               | `os.environ["NAME"]`  |
| [Perl](/runtimes/perl)             | Perl 5.42.2                  | `$ENV{NAME}`          |
| [Ruby](/runtimes/ruby)             | CRuby 4.0.0                  | `ENV["NAME"]`         |

Every run creates a fresh Wasm instance. Fuel, memory, and output bounds limit guest execution. Standard libraries depend on the selected engine; host networking, host files, and package installation are unavailable.

## Start here

- [Getting started](/get-started): deploy an engine and run your first request.
- [Guides](/guides): deploy a runtime Worker, execute code, use code contexts, and manage files.

## Explore

- [API reference](/api): request fields, responses, and error handling.
- [Concepts](/concepts): architecture, sandbox lifecycle, code contexts, runtime engines, and security model.
- [Configuration](/configuration): Wrangler configuration, transport detection, and environment variables.
- [Runtimes](/runtimes/javascript): per-language details for JavaScript, Python, Perl, and Ruby.
- [Platform](/platform): limits, licenses, and troubleshooting.

The npm packages are currently previews and have not been published. Source-based deployment templates work independently of npm publication once this repository and the template directories are public. Read [runtime licenses](/platform/licenses) and [limits](/platform/limits) before use.
