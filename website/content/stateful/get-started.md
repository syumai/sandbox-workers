---
title: Get started with stateful mode
description: Deploy a runtime Worker, host a Sandbox Durable Object in your own Worker, and run your first code context.
---

## 1. Deploy a runtime Worker per language

Deploy one private runtime Worker for each language you want to use. This guide uses two: Python and JavaScript.

Open [Deploy a runtime Worker](/deploy) and choose Python. In Cloudflare, select your account and a unique Worker name. Keep the detected build and deploy commands. The templates require a Paid Workers plan for their configured CPU allowance.

Record the deployed name, such as `sandbox-python`. A successful runtime deployment has no public URL; this is intentional.

Open [Deploy a runtime Worker](/deploy) again and repeat the same steps for JavaScript, recording that name too, such as `sandbox-javascript`.

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

Add the `Sandbox` Durable Object binding and its migration, plus one Service Binding per runtime Worker you deployed:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "JAVASCRIPT", "service": "sandbox-javascript" },
  ],
  "vars": {
    "SANDBOX_IDLE_TTL_MS": "86400000", // optional; "0" disables expiry
    // "SANDBOX_FILE_API": "disabled", // optional; turns the File API off (see Environment variables)
  },
}
```

The `service` value must exactly match the name you selected when deploying, and both Workers must belong to the same Cloudflare account. The binding names (`PYTHON`, `JAVASCRIPT`) are yours to choose. Each runtime Worker needs exactly one `services` entry; adding a language later is one more deploy plus one more entry here, with no change to the `Sandbox` configuration above it.

## 5. Run code in two languages that share one workspace

```ts
import { getSandbox } from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

interface Env {
  Sandbox: DurableObjectNamespace;
  PYTHON: Fetcher;
  JAVASCRIPT: Fetcher;
}

export default {
  async fetch(request: Request, env: Env) {
    const sandbox = getSandbox<Env>(env.Sandbox, "user-42");
    const py = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });
    const js = await sandbox.interpreter.createCodeContext({ binding: "JAVASCRIPT" });

    const squared = await sandbox.interpreter.runCode(
      "print('Hello!')\nimport os\nsquared = int(os.environ['X']) ** 2\nsquared",
      { context: py, envVars: { X: "12" } },
    );
    await sandbox.interpreter.runCode(
      "import json\nopen('/workspace/result.json', 'w').write(json.dumps({'squared': squared}))",
      { context: py },
    );
    const fromFile = await sandbox.interpreter.runCode(
      "fs.readFileSync('/workspace/result.json', 'utf8')",
      { context: js },
    );

    return Response.json({ squared, fromFile });
  },
};
```

Deploy your caller after both runtime Workers. `binding: "PYTHON"` and `binding: "JAVASCRIPT"` name the Service Bindings from step 4 — that's what selects the language, never a `language` option. `squared` has no `error`, `results: [{ text: "144" }]`, and the captured greeting in `logs.stdout`; `fromFile` reads back the file the Python context just wrote, so its result text contains `144` too.

Each context keeps its own language's globals — `py`'s `squared` variable isn't visible to `js`. But `/workspace` belongs to the sandbox, not to any one context, so the JavaScript context sees the file the Python context wrote there. `binding` selects which runtime Worker a context (or a call) talks to, and with `getSandbox<Env>`, it's checked against the Service Bindings in `Env` at compile time, so a typo like `binding: "PYTHOn"` fails to build instead of failing at runtime. State in each context — top-level variables, functions, imports — persists across calls; see [Use code contexts](/stateful/code-contexts).

## Add another language

Adding a third language is the same two steps again: deploy another runtime Worker from [Deploy a runtime Worker](/deploy), add one more `services` entry for it, and create a code context against that binding — it joins the same sandbox and the same `/workspace` as `py` and `js` above. Ruby and other stateless-only runtime Workers can't hold code contexts (see [Languages](/stateful#languages)), but you can still bind one in the same caller and call it with the free `runCode` alongside your stateful contexts.

## Next steps

- [Use code contexts](/stateful/code-contexts): keep state between executions with a durable REPL, and use several languages in one sandbox.
- [Manage files](/stateful/manage-files): read and write files under `/workspace`.
- [Security](/concepts/security): before exposing a caller that accepts arbitrary code, configure its authentication and rate limits.
- [API reference](/api): request fields, responses, and error handling.

Only need one-shot execution, with no persistent state or files? See [Stateless mode](/stateless).
