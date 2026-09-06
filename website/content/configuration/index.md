---
title: Configuration
description: Configure your own Worker's Sandbox Durable Object and runtime Service Bindings, the runtime Worker's wrangler.jsonc, and guest environment variables.
---

sandbox-workers splits configuration across two Workers: **your own Worker** (the caller), which hosts the `Sandbox` Durable Object and binds one or more runtime Workers by name, and the **runtime Worker**, which owns its `Interpreter` Durable Object, CPU limits, and idle-expiry settings. These pages cover both sides.

- [Wrangler configuration](/configuration/wrangler) — your `Sandbox` Durable Object binding and migration, the runtime Service Bindings, and the runtime Worker's own Durable Object binding, migration, and deploy settings.
- [Bindings](/configuration/bindings) — the `Sandbox` Durable Object binding, runtime Service Bindings, and binding-name rules that `createCodeContext({ binding })` resolves by name.
- [Environment variables](/configuration/environment-variables) — passing `envVars` to guest code, layering `setEnvVars` and context-level vars, and `SANDBOX_IDLE_TTL_MS` vs. `INTERPRETER_IDLE_TTL_MS`.

## Related resources

- [Getting started](/get-started) — install the client and run your first code context.
- [Deploy a runtime Worker](/guides/deploy) — deploy a private runtime Worker with a deploy button or the CLI.
- [Security model](/concepts/security) — isolation guarantees and public-caller responsibilities.
