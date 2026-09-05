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

const python = createSandbox(env.PYTHON, "python");
try {
  const output = await python.execute<number>({
    code: "return input['x'] ** 2",
    input: { x: 12 },
  });
  if (!output.ok) {
    console.error(output.error.name, output.error.message);
  } else {
    console.log(output.result);
  }
} catch (error) {
  // Binding failures, malformed responses, or HTTP 5xx.
  console.error(error);
}
```

The generic describes the expected result; it does not validate that shape at runtime. Guest errors return `ok: false`. Transport failures reject. The client sends code only to the supplied binding, never to the public Playground.

Before publication, install the local core tarball or use the raw fetch example in [Quickstart](/getting-started/quickstart).

## Multiple runtimes

Create one client per binding and language. JavaScript is the client's default when the second argument is omitted. Changing the language argument does not change the target Worker: both must agree.

In local development, run the target Workers too. The repository's `pnpm dev` starts all five Workers together. Separate projects can run separate Wrangler dev processes.

## Public callers

Keep runtime URLs disabled. If your caller accepts user-supplied code, apply authentication, rate limiting, and application-specific input validation at that boundary. A private engine does not secure an unrestricted public caller automatically.
