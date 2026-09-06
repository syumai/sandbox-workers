---
title: Get started with stateful mode
description: Deploy a runtime Worker, host a Sandbox Durable Object in your own Worker, and run your first code context.
---

## 1. Deploy a runtime Worker

Open [Deploy a runtime Worker](/deploy) and choose JavaScript, Python, Perl, or Ruby. In Cloudflare, select your account and a unique Worker name. Keep the detected build and deploy commands. The templates require a Paid Workers plan for their configured CPU allowance.

Record the deployed name, such as `sandbox-python`. A successful runtime deployment has no public URL; this is intentional.

## 2. Install the typed client

```sh
pnpm add @sandbox-workers/core
```

## 3. Export the Sandbox Durable Object

Your own Worker — not the runtime Worker — hosts the `Sandbox` Durable Object. Re-export it from your entry point:

```ts
export { Sandbox } from "@sandbox-workers/core";
```

## 4. Configure your `wrangler.jsonc`

Add the `Sandbox` Durable Object binding and its migration, plus a Service Binding to the runtime Worker you deployed:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "services": [{ "binding": "PYTHON", "service": "sandbox-python" }],
  "vars": { "SANDBOX_IDLE_TTL_MS": "86400000" }, // optional; "0" disables expiry
}
```

The `service` value must exactly match the name you selected when deploying. Both Workers must belong to the same Cloudflare account.

## 5. Create a code context and run code

```ts
import { getSandbox } from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

interface Env {
  Sandbox: DurableObjectNamespace;
  PYTHON: Fetcher;
}

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox<Env>(env.Sandbox, "user-42");
    const ctx = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });
    const result = await sandbox.interpreter.runCode(
      "print('Hello!')\nimport os\nint(os.environ['X']) ** 2",
      { context: ctx, envVars: { X: "12" } },
    );
    return Response.json(result);
  },
};
```

Deploy your caller after the runtime Worker. `binding: "PYTHON"` names the Service Binding from step 4 — that's what selects the language, never a `language` option. The result has no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`. State in this context (`ctx`) — top-level variables, functions, imports — persists across calls; see [Use code contexts](/stateful/code-contexts). With `getSandbox<Env>`, `binding` is checked against the Service Bindings in `Env` at compile time, so a typo like `binding: "PYTHOn"` fails to build instead of failing at runtime.

## Next steps

- [Use code contexts](/stateful/code-contexts): keep state between executions with a durable REPL, and share `/workspace` across languages.
- [Manage files](/stateful/manage-files): read and write files under `/workspace`.
- [Security](/concepts/security): before exposing a caller that accepts arbitrary code, configure its authentication and rate limits.
- [API reference](/api): request fields, responses, and error handling.

Only need one-shot execution, with no persistent state or files? See [Stateless mode](/stateless).
