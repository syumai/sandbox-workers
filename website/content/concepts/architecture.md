---
title: Architecture
description: How the gateway, runtime Workers, and Wasm engines fit together.
---

sandbox-workers splits execution into two kinds of Worker: a **caller Worker** (your application, or the Playground gateway) that decides which language to run, and one **runtime Worker per language** that actually runs it. The caller never runs guest code itself — it reaches a runtime Worker over a [Service Binding](/configuration/wrangler), and the runtime Worker boots a fresh Wasm engine instance for each execution.

Runtime Workers have no public URL: `workers_dev` and `preview_urls` are both false, so they are reachable only from Workers that hold a Service Binding (or a Durable Object namespace binding) to them. The [Playground](https://github.com/syumai/sandbox-workers/blob/main/README.md) that ships with this repository is the one exception that talks to more than one runtime — its gateway Worker reads the language out of the request path and forwards to the matching binding. A typical application binds directly to a single runtime Worker instead.

## Request flow

```text
Caller Worker / Playground gateway     src/index.ts
  ├── Static Assets / CodeMirror (Playground only)   ui/
  └── URL path or fixed binding → Service Binding
        │ { code, envVars }
        ▼
Runtime Worker (one per language)      engine/index.ts (public URLs disabled)
  └── Host-side transform + ABI        runtime/*.mjs, packages/<language>/src
        └── Fresh Wasm instance per execution
              └── Language engine (SpiderMonkey, CPython, Perl, or CRuby)
```

The gateway (`src/index.ts`) is only present in the Playground; it exists to pick a runtime from the URL path (`POST /execute/<language>`, or `/languages/<language>/sandboxes/:id/...`) and serves the CodeMirror UI as Static Assets from `ui/`. A caller Worker that only ever needs one language skips the gateway entirely and binds straight to that language's runtime Worker.

Each runtime Worker (`engine/index.ts` and its per-language variants) re-exports a language package under `packages/<language>/src`. On the host side, that package transforms or prepares the submitted code — for example, JavaScript's `runtime/javascript.mjs` wraps the submitted code in an async IIFE before evaluation — and drives the engine through a small runtime layer in `runtime/*.mjs`. Every execution gets its own Wasm instance and linear memory: nothing from a previous stateless `/execute` call is retained.

## The two host ABIs

JavaScript, Python, and Perl all talk to their engines through the same **wasmify protobuf ABI** (`runtime/protobuf.mjs`): the host serializes requests to the guest and reads back results, logs, and errors as protobuf messages over a shared calling convention. Ruby is the exception — it uses the official **RubyVM ABI** instead, which is why Ruby has different host-side integration code and different constraints (see [Runtime engines](/concepts/runtimes) and [Code contexts](/concepts/code-contexts)).

## Sandboxes and code contexts

JavaScript, Python, and Perl runtime Workers each export a `Sandbox` Durable Object class alongside their default fetch handler. This is what backs stateful [sandboxes](/concepts/sandboxes) and [code contexts](/concepts/code-contexts): a caller Worker gets a per-id Durable Object stub, and the runtime Worker's own `Sandbox` class owns the workspace and the durable REPLs. Ruby's runtime Worker exports only the default handler — it has no `Sandbox` class, so it supports only the stateless execution contract described above.

## Related resources

- [Sandbox lifecycle](/concepts/sandboxes)
- [Code contexts](/concepts/code-contexts)
- [Runtime engines](/concepts/runtimes)
- [Security model](/concepts/security)
- [Configuration: wrangler.jsonc](/configuration/wrangler)
