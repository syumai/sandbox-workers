---
title: Wrangler configuration
description: Your Sandbox Durable Object binding and its migration, the runtime Service Bindings, and the runtime Worker's own configuration.
---

Configuration is split across two `wrangler.jsonc` files: **your own Worker** (the caller), which hosts the `Sandbox` Durable Object and calls `getSandbox(env.Sandbox, id)`, and the private **runtime Worker** that runs guest code (deployed from a [deploy button or the CLI](/guides/deploy)). Deploy the runtime Worker first — your binding needs its Worker name.

## Your own `wrangler.jsonc`

Add the `Sandbox` Durable Object binding and its migration, plus a `services` entry per runtime Worker:

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "JAVASCRIPT", "service": "sandbox-javascript" },
  ],
  "vars": { "SANDBOX_IDLE_TTL_MS": "86400000" }, // optional; "0" disables expiry
}
```

And re-export the `Sandbox` class from your Worker's entry point:

```ts
export { Sandbox } from "@sandbox-workers/core";
```

The `durable_objects`/`migrations` block is required — there is no code-execution-only mode on this side, since `Sandbox` is what makes `getSandbox()` work at all. Each `services` entry names a runtime Worker; `binding` is the name `createCodeContext({ binding })` and `runCode({ binding })` refer to, not something the client selects — see [Bindings](/configuration/bindings). A Service Binding targets a Worker in the same Cloudflare account. Installing `@sandbox-workers/core` alone does not create a Worker or a binding — each runtime Worker must already be deployed under the name used above.

If you don't need code contexts or files at all, you can skip the `Sandbox` binding entirely and call a runtime Worker's Service Binding directly with the free `runCode` function (see [Execute code](/guides/execute-code)) — no Durable Object configuration required on your side in that case.

## The runtime Worker's `wrangler.jsonc`

The CLI initializer (`sandbox-workers init javascript|python|perl|ruby`) and the deploy-to-Cloudflare templates already generate this side of the configuration — you don't normally hand-write it. The generated JavaScript, Python, and Perl templates include:

```jsonc
{
  "name": "sandbox-javascript",
  "main": "index.js",
  "compatibility_date": "2026-09-04",
  "workers_dev": false,
  "preview_urls": false,
  "limits": { "cpu_ms": 2000 },
  "durable_objects": {
    "bindings": [{ "name": "INTERPRETER", "class_name": "Interpreter" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Interpreter"] }],
}
```

(The Python and Perl templates are identical apart from `name`.) Ruby has **no Durable Object binding and no migration** — code contexts are not supported on the Ruby runtime, so its `wrangler.jsonc` omits `durable_objects` and `migrations` entirely, and `GET /interpreter` reports `contexts: false`. The CLI's `--stateless` flag produces the same shape for any language.

A few settings are worth understanding rather than just copying:

- **`durable_objects` + `migrations`** — the `Interpreter` Durable Object class backs code contexts on this runtime Worker: per-context memory snapshots and the in-memory workspace mirror. The `new_sqlite_classes` migration is required the first time the class is deployed; it belongs to the runtime Worker's own configuration, never the caller's.
- **`workers_dev: false` and `preview_urls: false`** — the runtime Worker has no public URL and no routes. It is reachable only through the Service Binding configured on your side.
- **`limits.cpu_ms`** — interpreter startup and execution can exceed the Free plan's CPU budget, so a [Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) is required to run these engines in production.
- **`vars`** — runtime Worker settings such as `INTERPRETER_IDLE_TTL_MS` go here. See [Environment variables](/configuration/environment-variables).

## Related resources

- [Deploy a runtime Worker](/guides/deploy) — deploy buttons and the CLI initializer.
- [Bindings](/configuration/bindings) — binding-name rules and how `createCodeContext({ binding })` resolves them.
- [Environment variables](/configuration/environment-variables) — guest `envVars` and both idle-TTL settings.
- [Runtime licenses](/platform/licenses) — review before deploying or redistributing a runtime Worker.
