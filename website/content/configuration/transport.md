---
title: Transport
description: The two kinds of target getSandbox() accepts — a Service Binding or a Durable Object namespace — and how the client tells them apart.
---

`getSandbox(target, id)` accepts either of two binding shapes for `target`. The client detects which one it received and talks to the runtime Worker accordingly.

## Service Binding

A plain Service Binding to the runtime Worker (`Fetcher`-shaped: it has `fetch()` but no `idFromName`). The client sends requests to `https://sandbox.internal/sandboxes/<id>/...` over the binding:

```jsonc
{
  "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }],
}
```

This is the configuration [Wrangler configuration](/configuration/wrangler) and [Getting started](/get-started) use. It requires no Durable Object binding and no migration in the caller — the runtime Worker's own `wrangler.jsonc` owns the `Sandbox` Durable Object class.

## Durable Object namespace

A Durable Object namespace bound with `script_name` pointing at the runtime Worker's `Sandbox` class. The client detects this shape by its `idFromName` method:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox", "script_name": "sandbox-javascript" }],
  },
}
```

No migration is needed in the caller — the migration that creates the `Sandbox` class already lives in the runtime Worker's own configuration. With this binding, the client calls `target.get(target.idFromName(id)).fetch(request)` directly, setting an `x-sandbox-id: <id>` header and using the request path **without** the `/sandboxes/<id>` prefix that the Service Binding form uses.

## When to use which

A Service Binding is the simpler default: it's what the deploy templates and the CLI initializer assume on the runtime side, and it keeps the caller's configuration to a single `services` entry. Bind directly to the Durable Object namespace instead when your caller already needs `script_name` access to the runtime Worker for other reasons, or when you want the caller to reach the `Sandbox` class without going through the runtime Worker's own `fetch` handler.

Either way, the typed client's API is identical — `getSandbox()` returns the same `Sandbox` interface regardless of which `target` shape it was given.

## Related resources

- [Wrangler configuration](/configuration/wrangler) — full caller and runtime Worker configuration.
- [Lifecycle](/api/lifecycle) — `getSandbox()` and sandbox id rules.
