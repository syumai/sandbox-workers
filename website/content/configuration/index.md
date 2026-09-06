---
title: Configuration
description: Configure your own Worker's wrangler.jsonc for stateless or stateful mode, the runtime Worker's wrangler.jsonc, and guest environment variables.
---

Configuration differs by mode. In **stateless mode**, your own Worker needs only a `services` entry naming the runtime Worker. In **stateful mode**, your own Worker additionally hosts the `Sandbox` Durable Object and binds it with `durable_objects`. Either way, the **runtime Worker** owns its own `Interpreter` Durable Object (when it has one), CPU limits, and idle-expiry settings. These pages cover both sides.

- [Wrangler configuration](/configuration/wrangler) — your Worker's `wrangler.jsonc` for each mode, the runtime Service Bindings, and the runtime Worker's own Durable Object binding, migration, and deploy settings.
- [Bindings](/configuration/bindings) — the runtime Service Bindings used by both modes, the `Sandbox` Durable Object binding stateful mode adds, and binding-name rules that `createCodeContext({ binding })` resolves by name.
- [Environment variables](/configuration/environment-variables) — passing `envVars` to guest code in both modes, layering `setEnvVars` and context-level vars in stateful mode, and `SANDBOX_IDLE_TTL_MS` vs. `INTERPRETER_IDLE_TTL_MS`.

## Related resources

- [Get started with stateless mode](/stateless/get-started) — add a `services` entry and call the free `runCode`.
- [Get started with stateful mode](/stateful/get-started) — install the client and run your first code context.
- [Deploy a runtime Worker](/deploy) — deploy a private runtime Worker with a deploy button or the CLI.
- [Security model](/concepts/security) — isolation guarantees and public-caller responsibilities.
