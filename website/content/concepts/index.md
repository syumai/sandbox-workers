---
title: Concepts
description: How sandbox-workers is structured, why it's designed this way, and what you need to understand to use it safely.
---

These pages explain how sandbox-workers works under the hood: the split between the gateway, the runtime Workers, and the Wasm engines; how sandboxes and code contexts persist state; how each language is isolated; and what security responsibilities stay with the caller.

- [Architecture](/concepts/architecture) - How the caller Worker, runtime Workers, and Wasm engines fit together
- [Sandbox lifecycle](/concepts/sandboxes) - Creation, persistence, idle expiry, and destruction
- [Code contexts](/concepts/code-contexts) - Durable REPLs and the memory-snapshot mechanism behind them
- [Runtime engines](/concepts/runtimes) - How each language's Wasm engine is instrumented, capped, and isolated
- [Security model](/concepts/security) - Isolation guarantees and what the caller must still implement

## Related resources

- [How-to guides](/guides) - Task-oriented instructions
- [API reference](/api) - Method signatures and the HTTP contract
- [Configuration](/configuration) - `wrangler.jsonc` bindings and environment variables
