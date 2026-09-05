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
import { createSandbox, SandboxTransportError } from "@sandbox-workers/core";

const python = createSandbox(env.PYTHON);
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
  // Binding failures, malformed responses, or HTTP 5xx.
  console.error(error);
}
```

`runCode` always resolves to an `ExecutionResult`; it does not validate the result's shape at runtime. Guest errors set `output.error` instead of throwing. Transport failures (a malformed response or a non-2xx status) reject with `SandboxTransportError`. The client sends code only to the supplied binding, never to the public Playground. There is no persistent context between calls: every call boots a fresh Wasm instance.

Before publication, install the local core tarball or use the raw fetch example in [Quickstart](/getting-started/quickstart).

## Multiple runtimes

Create one client per binding. `createSandbox(binding)` takes only the binding — the runtime is whichever Worker that binding targets, not something the client selects.

In local development, run the target Workers too. The repository's `pnpm dev` starts all five Workers together. Separate projects can run separate Wrangler dev processes.

## Public callers

Keep runtime URLs disabled. If your caller accepts user-supplied code, apply authentication, rate limiting, and application-specific input validation at that boundary. A private engine does not secure an unrestricted public caller automatically.
