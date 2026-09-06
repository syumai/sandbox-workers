---
title: Wrangler configuration
description: The caller's Service Binding entry and the runtime Worker's Durable Object binding, migration, and deploy settings.
---

Configuration is split across two `wrangler.jsonc` files: the application that calls a sandbox (the **caller**), and the private engine Worker that runs guest code (the **runtime Worker**, deployed from a [deploy button or the CLI](/guides/deploy)). Deploy the runtime Worker first — the caller's binding needs its Worker name.

## The caller's `wrangler.jsonc`

Add a `services` entry that points at the runtime Worker's deployed name:

```jsonc
{
  "services": [{ "binding": "SANDBOX", "service": "sandbox-python" }],
}
```

A Service Binding always targets exactly one runtime Worker — there is no `language` field in the request to route it elsewhere. To use more than one runtime from the same caller, add one binding per deployed Worker:

```jsonc
{
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "RUBY", "service": "sandbox-ruby" },
  ],
}
```

A Service Binding targets a Worker in the same Cloudflare account. Installing `@sandbox-workers/core` alone does not create a Worker or a binding — the runtime Worker must already be deployed under the name used above.

The caller needs no Durable Object binding of its own for this configuration: the client talks to the runtime Worker's `/sandboxes/:id` routes over the same Service Binding used for stateless execution. See [Transport](/configuration/transport) for the alternative — binding directly to the runtime Worker's `Sandbox` Durable Object class.

## The runtime Worker's `wrangler.jsonc`

The CLI initializer (`sandbox-workers init javascript|python|perl|ruby`) and the deploy-to-Cloudflare templates already generate this side of the configuration — you don't normally hand-write it. The generated JavaScript, Python, and Perl templates include:

```jsonc
{
  "name": "sandbox-javascript",
  "main": "runtime/worker.js",
  "compatibility_date": "2026-09-04",
  "workers_dev": false,
  "preview_urls": false,
  "limits": { "cpu_ms": 2000 },
  "durable_objects": {
    "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
}
```

(The Python and Perl templates are identical apart from `name`.) Ruby has **no Durable Object binding and no migration** — code contexts are not supported on the Ruby runtime, so its `wrangler.jsonc` omits `durable_objects` and `migrations` entirely.

A few settings are worth understanding rather than just copying:

- **`durable_objects` + `migrations`** — the `Sandbox` Durable Object class backs sandboxes and code contexts. The `new_sqlite_classes` migration is required the first time the class is deployed; it belongs to the runtime Worker's own configuration, never the caller's.
- **`workers_dev: false` and `preview_urls: false`** — the runtime Worker has no public URL and no routes. It is reachable only through the Service Binding (or Durable Object namespace) configured in the caller.
- **`limits.cpu_ms`** — interpreter startup and execution can exceed the Free plan's CPU budget, so a [Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) is required to run these engines in production.
- **`vars`** — runtime Worker settings such as `SESSION_IDLE_TTL_MS` go here. See [Environment variables](/configuration/environment-variables).

## Related resources

- [Deploy a runtime Worker](/guides/deploy) — deploy buttons and the CLI initializer.
- [Transport](/configuration/transport) — the Service Binding vs. Durable Object namespace choice for the caller.
- [Environment variables](/configuration/environment-variables) — guest `envVars` and the runtime Worker's `vars`.
- [Runtime licenses](/platform/licenses) — review before deploying or redistributing a runtime Worker.
