---
title: Getting started
description: Deploy a private runtime and return your first JSON result.
---

## 1. Deploy an engine

Open [Deploy a runtime Worker](/guides/deploy) and choose JavaScript, Python, Perl, or Ruby. In Cloudflare, select your account and a unique Worker name. Keep the detected build and deploy commands. The templates require a Paid Workers plan for their configured CPU allowance.

Record the deployed name, such as `sandbox-python`. A successful engine deployment has no public URL; this is intentional.

## 2. Add a Service Binding

Merge this into your application's `wrangler.jsonc`:

```jsonc
{
  "services": [{ "binding": "SANDBOX", "service": "sandbox-python" }],
}
```

The service value must exactly match the name you selected. Both Workers must belong to the same Cloudflare account.

## 3. Install the typed client

```sh
pnpm add @sandbox-workers/core
```

## 4. Execute code

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

Deploy your caller after the engine. `getSandbox` takes the binding and a sandbox id; `runCode` sends the request over the binding only, so nothing leaves your account. The result has no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`.

## Next steps

- [Execute code](/guides/execute-code): read `results`, `logs`, and `error`, and use one client per binding for multiple runtimes.
- [Deploy a runtime Worker](/guides/deploy): deploy buttons for every language, plus the CLI and local-package workflow before npm publication.
- [Use code contexts](/guides/code-contexts): keep state between executions with a durable REPL.
- [Manage files](/guides/manage-files): read and write files under `/workspace`.
- [Security](/concepts/security): before exposing a caller that accepts arbitrary code, configure its authentication and rate limits.
- [API reference](/api): request fields, responses, and error handling.
