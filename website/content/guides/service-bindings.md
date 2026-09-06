---
title: Service Bindings
description: Connect private engines to your Worker application.
---

## Bind to a deployed engine

```jsonc
{
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "RUBY", "service": "sandbox-ruby" },
  ],
}
```

Deploy each target first, and use its actual name. A Service Binding targets a Worker in the same account. A package installation alone does not create a Worker or binding.

## Use the typed client

After package publication:

```sh
pnpm add @sandbox-workers/core
```

```ts
import { getSandbox, SandboxError } from "@sandbox-workers/core";

const python = getSandbox(env.PYTHON, "user-42");
try {
  const output = await python.runCode("import os\nint(os.environ['X']) ** 2", {
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

`runCode` always resolves to an `ExecutionResult`; it does not validate the result's shape at runtime. Guest errors set `output.error` instead of throwing. Transport failures (a malformed response or a non-2xx status) throw a `SandboxError` subclass. The client sends code only to the supplied binding, never to the public Playground. Stateless `runCode` (no `context` option) has no persistent context between calls: every call boots a fresh Wasm instance.

Before publication, install the local core tarball produced by `pnpm run pack`.

## Multiple runtimes

Create one client per binding. `getSandbox(binding, id)` takes the binding and a sandbox id — the runtime is whichever Worker that binding targets, not something the client selects.

In local development, run the target Workers too. The repository's `pnpm dev` starts all five Workers together. Separate projects can run separate Wrangler dev processes.

## Public callers

Keep runtime URLs disabled. If your caller accepts user-supplied code, apply authentication, rate limiting, and application-specific input validation at that boundary. A private engine does not secure an unrestricted public caller automatically.

## Code contexts and Durable Objects

`runCode` above is stateless — every call boots a fresh Wasm instance. [Sandboxes and code contexts](/guides/sessions) add a durable, stateful REPL through `getSandbox(env.SANDBOX, id)` and `createCodeContext()`, backed by a Durable Object exported by the runtime Worker (JavaScript, Python, and Perl; not Ruby). The Durable Object binding and its `new_sqlite_classes` migration belong to the **runtime Worker's own** `wrangler.jsonc`, not the caller's:

```jsonc
// Runtime Worker's wrangler.jsonc, not the caller's
{
  "durable_objects": {
    "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
}
```

The CLI initializer and the deploy-to-Cloudflare templates already configure this for the three supported languages. The calling application still only needs the plain Service Binding shown above — no Durable Object binding is required there, because the client talks to the runtime Worker's `/sandboxes/:id` routes over the same binding used for `/execute`.

Alternatively, the caller can bind directly to the runtime Worker's `Sandbox` class as a Durable Object namespace, with `script_name` pointing at the runtime Worker and no migration of its own:

```jsonc
// Caller's wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox", "script_name": "sandbox-javascript" }],
  },
}
```
