---
title: Quickstart
description: Deploy a private runtime and return your first JSON result.
---

## 1. Deploy an engine

Open [Deploy to Cloudflare](/getting-started/deploy) and choose JavaScript, Python, Perl, or Ruby. In Cloudflare, select your account and a unique Worker name. Keep the detected build and deploy commands. The templates require a Paid Workers plan for their configured CPU allowance.

Record the deployed name, such as `sandbox-python`. A successful engine deployment has no public URL; this is intentional.

## 2. Add a Service Binding

Merge this into your application's `wrangler.jsonc`:

```jsonc
{
  "services": [{ "binding": "SANDBOX", "service": "sandbox-python" }],
}
```

The service value must exactly match the name you selected. Both Workers must belong to the same Cloudflare account.

## 3. Execute code

Install the typed client in your application:

```sh
pnpm add @sandbox-workers/core
```

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

Deploy your caller after the engine. `getSandbox` takes the binding and a sandbox id; `runCode` sends the request over the binding only, so nothing leaves your account. The result has no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`. Before publication, install the local core tarball instead (see [Service Bindings](/guides/service-bindings)).

Before exposing a caller that accepts arbitrary code, configure its authentication and rate limits. See [Service Bindings](/guides/service-bindings) for error handling and multiple engines.
