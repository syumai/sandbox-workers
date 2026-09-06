---
title: Execute code
description: Run code in stateless mode with the free runCode function and handle results and errors.
---

This is the **stateless mode** guide: it shows you how to run code with the free `runCode` function, read the result, and handle errors. For a durable alternative with state and files, see [Use code contexts](/stateful/code-contexts) instead — that's stateful mode.

## Use the free `runCode` function

```sh
pnpm add @sandbox-workers/core
```

```ts
import { runCode, SandboxError } from "@sandbox-workers/core";

try {
  const output = await runCode(env.PYTHON, "import os\nint(os.environ['X']) ** 2", {
    envVars: { X: "12" },
  });
  if (output.error) {
    console.error(output.error.name, output.error.message);
  } else {
    console.log(output.results[0]);
  }
} catch (error) {
  // Binding failures, malformed responses, or a non-200 response
  // (a SandboxError subclass such as ValidationFailedError).
  console.error(error);
}
```

This is the **stateless mode** path: `runCode(target, code, options?)` boots a fresh Wasm instance for every call — no code context, no files, nothing persists between calls. `target` must be a Service Binding (`Fetcher`) to the runtime Worker; a `Sandbox` Durable Object namespace throws synchronously — use `getSandbox(env.Sandbox, id).interpreter.runCode()` for that instead, since a stateless call has no sandbox id to route through. `runCode` always resolves to an `ExecutionResult`; it does not validate the result's shape at runtime. Guest errors set `output.error` instead of throwing. Transport failures (a malformed response or a non-2xx status) throw a `SandboxError` subclass. The client sends code only to the supplied binding, never to a public URL.

For a durable, stateful-mode alternative — top-level variables persisting across calls in a named code context, shared `/workspace`, several languages in one sandbox — use `getSandbox(env.Sandbox, id).interpreter.runCode(code, { context })` instead. See [Use code contexts](/stateful/code-contexts) for the full walkthrough.

Before publication, install the local core tarball produced by `pnpm run pack` (see [Deploy a runtime Worker](/deploy)).

## Read the result

Code is a script: the value of the last top-level expression becomes the result. `results` has at most one entry:

| Value                                              | Entry                                        |
| --------------------------------------------------- | --------------------------------------------- |
| JS `undefined`, Python `None`, Ruby `nil`, Perl `undef` | none — `results` is `[]`                  |
| Container (JS object/array, Python dict/list, Ruby Hash/Array, Perl HASH/ARRAY ref) | `{ "json": ... }`      |
| Anything else                                       | `{ "text": "..." }`, the language's native string representation |

The native `text` representation matches the language's own printing: JavaScript uses a `util.inspect`-like form (strings single-quoted, e.g. `'hi'`; BigInt as `123n`), Python uses `repr(v)`, Ruby uses `v.inspect`, and Perl uses `"$v"` string interpolation. If a container fails to serialize as JSON, it falls back to a `text` entry using the same native representation.

`logs.stdout` and `logs.stderr` carry captured output, and are returned even when the run ends in a guest error. A guest error sets `error: { name, message, traceback? }` and leaves `results` empty. See [the interpreter API reference](/api/interpreter) for the full `ExecutionResult` shape and [errors](/api/errors) for the `SandboxError` hierarchy thrown for transport failures.

### Env vars per language

Only the key/value pairs passed in `envVars` are visible to the script; nothing from the host environment leaks through.

| Language   | Access                |
| ---------- | ---------------------- |
| JavaScript | `process.env.NAME`     |
| Python     | `os.environ["NAME"]`   |
| Perl       | `$ENV{NAME}`            |
| Ruby       | `ENV["NAME"]`           |

## Use multiple runtimes

Bind one Service Binding per runtime Worker. `runCode(binding, id)` takes the binding directly — the runtime is whichever Worker that binding targets, not something the client selects.

```jsonc
{
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "RUBY", "service": "sandbox-ruby" },
  ],
}
```

Deploy each target first, and use its actual name. A Service Binding targets a Worker in the same account. A package installation alone does not create a Worker or binding.

In local development, run the target Workers too. The repository's `pnpm dev` starts all five Workers together. Separate projects can run separate Wrangler dev processes.

## Public callers

Keep runtime URLs disabled. If your caller accepts user-supplied code, apply authentication, rate limiting, and application-specific input validation at that boundary. A private runtime Worker does not secure an unrestricted public caller automatically. See [the security concepts page](/concepts/security) for more.
