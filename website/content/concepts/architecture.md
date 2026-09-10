---
title: Architecture
description: The caller-hosted Sandbox Durable Object, per-runtime Interpreter Durable Objects, and the workspace mirror between them.
---

sandbox-workers splits execution across three kinds of Worker: **your own Worker** (the caller, or the Playground gateway), which hosts a `Sandbox` Durable Object and decides which languages to use; and one **runtime Worker per language** (`@sandbox-workers/javascript`, `python`, `perl`, `ruby`), each with its own `Interpreter` Durable Object, that actually runs guest code. This mirrors the [Sandbox SDK 1.0 preview](https://developers.cloudflare.com/sandbox/1-0-preview/)'s shape — `getSandbox(env.Sandbox, id)`, `sandbox.interpreter.*` — adapted to Wasm-per-language Workers instead of one container.

Runtime Workers have no public URL: `workers_dev` and `preview_urls` are both false, so they are reachable only from Workers that hold a Service Binding to them. The [Playground](https://github.com/syumai/sandbox-workers/blob/main/README.md) that ships with this repository is the one exception that talks to more than one runtime — its gateway Worker hosts its own `Sandbox` and forwards to the matching binding based on the request path.

## Model

```text
Caller Worker (your app, or the Playground gateway)
  ├── getSandbox(env.Sandbox, "user-42")            @sandbox-workers/core client
  └── Sandbox Durable Object  (class from @sandbox-workers/core, no Wasm)
        owns: /workspace (files + directories), envVars, context registry, idle expiry
        │  env[context.binding].executeInContext(key, { code, envVars, workspace manifest }, getFiles)  (RPC)
        ▼
Runtime Worker, one per language   (@sandbox-workers/<language>, deployed privately)
  ├── POST /execute                stateless, unchanged
  ├── GET  /interpreter            { language, engine, contexts }
  └── Interpreter Durable Object   keyed by the sandbox's own id
        owns: per-context memory snapshots, an in-memory workspace mirror
```

**`Sandbox`** is a plain TypeScript class exported by `@sandbox-workers/core` — it does not extend `cloudflare:workers`'s `DurableObject` and has no build-time dependency on Workers types. Your own Worker re-exports it (`export { Sandbox } from "@sandbox-workers/core"`) and binds it with `durable_objects`; `getSandbox(env.Sandbox, id)` returns a typed client for one instance, keyed by the caller-chosen `id`. It owns `/workspace` (files and, since this design, empty directories too), `envVars`, the registry of code contexts, and idle expiry — but no Wasm engine at all: every code context is bound to a runtime Worker by the **name of a Service Binding** in your own environment, and every execution is proxied there.

**`Interpreter`** is each runtime Worker's own Durable Object class (renamed in place from the earlier `Sandbox`), keyed by **the caller's `Sandbox` Durable Object's own id** — so two callers using the same sandbox id against the same runtime Worker never collide. It owns per-context memory snapshots and an in-memory-only mirror of `/workspace`, reconciled at the top of every `executeInContext` call by pulling whatever it's missing back from the `Sandbox` over a Workers RPC callback. There is no `files` table on this side any more: `/workspace` has exactly one source of truth, the caller's `Sandbox`.

Every runtime Worker — the four in this repository and any third party's — is built on **`@sandbox-workers/interpreter`**, a separate published package from `@sandbox-workers/core`: its `InterpreterWorker`/`InterpreterDurableObject` base classes (usually via the `defineInterpreterRuntime(engine)` helper) implement the wire protocol above (routing, the Durable Object's storage, the workspace mirror, snapshot diffing, idle expiry) once, so a language package supplies only an `Engine` — the Wasm module or other interpreter, resource limits, and, for durable code contexts, session boot/restore. See [Build your own runtime](/runtimes/custom) and the package's own README for the full contract.

## Request flow

A code execution in a context makes two hops, over Workers RPC rather than HTTP: your Worker calls its own `Sandbox` (over the Durable Object binding), which resolves the context and calls the binding's runtime Worker's `executeInContext(key, args, getFiles)` RPC method — `args.workspace` is only the *shape* of `/workspace` (directories and file hashes), and `getFiles` is a callback the runtime Worker forwards, still as an RPC stub, to its own `Interpreter` (keyed by `<key>`, the sandbox's id). The `Interpreter` reconciles its mirror (calling `getFiles` back for whatever content it's missing), runs the code, snapshots memory, and returns a workspace diff. The `Sandbox` applies that diff to its own tree and answers your Worker. A stateless call — stateless mode's free `runCode` against a Service Binding directly, or the stateful-mode fallback (`sandbox.interpreter.runCode({ binding })` against a `contexts: false` binding) — skips the `Interpreter` and the workspace mirror entirely: it's a single HTTP hop to the runtime Worker's plain `POST /execute`.

```text
Your Worker → Sandbox DO → runtime Worker → Interpreter DO → Wasm engine
                  (context resolution,          (workspace mirror,
                   RPC: executeInContext)         pull via getFiles,
                                                   snapshot restore/save)
```

Each runtime Worker (`engine/index.ts` and its per-language variants) re-exports a language package under `packages/<language>/src`. On the host side, that package transforms or prepares the submitted code — for example, JavaScript's `packages/javascript/src/engine.mjs` wraps the submitted code in an async IIFE before evaluation — and drives the engine through the shared WASI/wasmify host in `@sandbox-workers/interpreter`'s `./wasi` and `./wasmify` subpaths. A stateless execution gets its own Wasm instance and linear memory every time; a code-context execution restores the engine from its stored snapshot instead of booting fresh (see [Code contexts](/concepts/code-contexts)).

## The two host ABIs

JavaScript, Python, and Perl all talk to their engines through the same **wasmify protobuf ABI** (`@sandbox-workers/interpreter/wasmify`): the host serializes requests to the guest and reads back results, logs, and errors as protobuf messages over a shared calling convention. Ruby is the exception — it uses the official **RubyVM ABI** instead, which is why Ruby has different host-side integration code and different constraints (see [Runtime engines](/concepts/runtimes) and [Code contexts](/concepts/code-contexts)).

## What this is not

There is no process execution, no terminals, no ports or tunnels, no backups, no `runCodeStream`, and no streaming callbacks — `onStdout`/`onStderr`/`onResult`/`onError` all fire after the response arrives. This project runs one thing — a code interpreter with a shared workspace — on Wasm rather than containers; see [the design document](https://github.com/syumai/sandbox-workers/blob/main/docs/sandbox-1-0-design.md) for the full scope.

## Related resources

- [Sandbox lifecycle](/concepts/sandboxes)
- [Code contexts](/concepts/code-contexts)
- [Runtime engines](/concepts/runtimes)
- [Security model](/concepts/security)
- [Configuration: wrangler.jsonc](/configuration/wrangler)
- [Build your own runtime](/runtimes/custom)
