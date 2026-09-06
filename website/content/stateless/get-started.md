---
title: Get started with stateless mode
description: Deploy a runtime Worker and call it directly with the free runCode function — no sandbox, no code context, no files.
---

## 1. Deploy a runtime Worker per language

Deploy one runtime Worker for each language you need. This guide deploys Python first.

Open [Deploy a runtime Worker](/deploy) and choose Python. In Cloudflare, select your account and a unique Worker name. Keep the detected build and deploy commands. The templates require a Paid Workers plan for their configured CPU allowance.

Record the deployed name, such as `sandbox-python`. A successful runtime deployment has no public URL; this is intentional.

Open [Deploy a runtime Worker](/deploy) again and repeat for JavaScript as a second runtime Worker, recording that name too, such as `sandbox-javascript` — the example below calls both.

## 2. Install the typed client

```sh
pnpm add @sandbox-workers/core
```

## 3. Add a `services` entry per runtime Worker

Stateless mode needs only a Service Binding to each runtime Worker you deployed — no `durable_objects`, no `migrations`, and no `Sandbox` export in your entry point:

```jsonc
{
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "JAVASCRIPT", "service": "sandbox-javascript" },
  ],
}
```

One entry per runtime Worker; the binding names are yours to choose. Each `service` value must exactly match the name you selected when deploying, and every bound Worker must belong to the same Cloudflare account.

## 4. Call `runCode`

```ts
import { runCode } from "@sandbox-workers/core";

export default {
  async fetch(request, env) {
    const result = await runCode(
      env.PYTHON,
      "print('Hello!')\nimport os\nint(os.environ['X']) ** 2",
      { envVars: { X: "12" } },
    );
    return Response.json(result);
  },
};
```

Deploy your caller after the runtime Worker. `env.PYTHON` names the Service Binding from step 3 — that's what selects the language, never a `language` option. `runCode(target, code, options?)` sends the request over the binding only, so nothing leaves your account — no sandbox, no code context, just a fresh Wasm instance for this one call.

The result has no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`. Nothing about this call persists — the next call starts from scratch.

Calling a second runtime Worker is the same function again, against the other binding:

```ts
const jsResult = await runCode(env.JAVASCRIPT, "1 + 1");
```

The binding you pass is the only thing that selects the language — call as many runtime Workers as you have bound.

## Next steps

- [Execute code](/stateless/execute-code): read `results`, `logs`, and `error`, and use one binding per runtime for multiple languages.
- [Security](/concepts/security): before exposing a caller that accepts arbitrary code, configure its authentication and rate limits.
- [API: the free `runCode()` function](/api/interpreter#runcode-free-function-stateless-mode): the full signature and result shape.

Need state or files? See [Get started with stateful mode](/stateful/get-started).
