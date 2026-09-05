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

This caller needs no sandbox-workers npm package:

```ts
export default {
  async fetch(request, env) {
    const response = await env.SANDBOX.fetch(
      new Request("https://sandbox.internal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "print('Hello!')\nimport os\nint(os.environ['X']) ** 2",
          envVars: { X: "12" },
        }),
      }),
    );
    return Response.json(await response.json());
  },
};
```

Deploy your caller after the engine. The result has no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`. The internal URL selects the endpoint path; it does not create a DNS request to a public server.

Before exposing a caller that accepts arbitrary code, configure its authentication and rate limits. See [Service Bindings](/guides/service-bindings) for the typed client and multiple engines.
