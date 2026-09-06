---
title: Configuration
description: Configure the caller Worker's binding, the runtime Worker's wrangler.jsonc, and guest environment variables.
---

sandbox-workers splits configuration across two Workers: the **caller** Worker, which holds a binding to a runtime, and the **runtime** Worker, which owns the Durable Object, CPU limits, and idle-expiry settings for the sandboxes it hosts. These pages cover both sides.

- [Wrangler configuration](/configuration/wrangler) — the caller's Service Binding entry and the runtime Worker's Durable Object binding, migration, and deploy settings.
- [Transport](/configuration/transport) — the two kinds of `target` `getSandbox()` accepts (a Service Binding or a Durable Object namespace) and when to use each.
- [Environment variables](/configuration/environment-variables) — passing `envVars` to guest code, layering `setEnvVars` and context-level vars, and the runtime Worker's `SESSION_IDLE_TTL_MS` setting.

## Related resources

- [Getting started](/get-started) — install the client and run your first execution.
- [Deploy a runtime Worker](/guides/deploy) — deploy a private engine Worker with a deploy button or the CLI.
- [Security model](/concepts/security) — isolation guarantees and public-caller responsibilities.
