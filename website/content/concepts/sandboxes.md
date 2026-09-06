---
title: Sandbox lifecycle
description: How sandboxes are created, what persists, the two idle timers, and destruction.
---

A **sandbox** is a `Sandbox` Durable Object, hosted by your own Worker, keyed by a caller-chosen id. It owns a writable `/workspace` directory and one or more [code contexts](/concepts/code-contexts) — named, durable REPLs, each bound to a runtime Worker, that keep an interpreter's globals alive between executions.

## Creation

A sandbox is created the first time a request touches its id — there is no separate "create sandbox" call. The caller picks the id (for example `user-42`); the `Sandbox` Durable Object does not authenticate it, so an application that accepts user input is responsible for scoping ids to a tenant (see [Security model](/concepts/security)).

## What persists, and what doesn't

- **`/workspace`** is shared by every context in the sandbox, regardless of which binding it's bound to: files written from one context are visible from another, and they survive across executions, redeploys, and Durable Object eviction or hibernation. **Empty directories persist too** — a directory created with `mkdir` and never written into is stored as its own row and survives eviction, the same as a file.
- **A code context's globals** (top-level variables, functions, classes, imported modules) persist the same way, through the memory-snapshot mechanism described in [Code contexts](/concepts/code-contexts) — not by keeping the interpreter resident, but by restoring it from a stored snapshot on that context's runtime Worker.
- Nothing persists for **stateless mode**: the free `runCode` function, a plain `POST /execute` request, or `sandbox.interpreter.runCode({ binding })` against a `contexts: false` binding all boot a fresh Wasm instance every time, with no memory of any prior call.
- **A storage-format change is the one exception to "survives redeploys."** Both the `Sandbox` and each `Interpreter` Durable Object keep a format number in their stored metadata; when a deploy changes the on-disk layout, the first touch afterward wipes that object and starts fresh rather than migrating, with no way to recover the wiped state. This has happened several times so far as the storage layout evolved. It's a non-event for short-TTL deployments (idle sandboxes are already being recycled), but a deployment with a long or disabled idle TTL should expect long-lived sandboxes to be reset by a format-changing upgrade.

## Two idle timers

Expiry is configured **separately on each side**, because the sandbox and its contexts' interpreters live in different Durable Objects, possibly in different Workers you deployed independently:

- **`SANDBOX_IDLE_TTL_MS`**, read from **your own Worker's** `vars` (the caller side): how long the whole sandbox — every code context's registry entry plus `/workspace` — can sit idle before the `Sandbox` Durable Object deletes it.
- **`INTERPRETER_IDLE_TTL_MS`**, read from **each runtime Worker's** own `vars`: how long that Worker's `Interpreter` Durable Object keeps a given sandbox's contexts' memory snapshots before wiping them.

Both default to 24 hours and both treat `"0"` as "never expire." See [Environment variables](/configuration/environment-variables) for where to set each one.

**Set `INTERPRETER_IDLE_TTL_MS` to at least `SANDBOX_IDLE_TTL_MS`.** If a runtime Worker's interpreter expires first, its memory snapshots are gone while the sandbox's registry still lists the context as live — the next `runCode` against it fails with `ContextNotFoundError`, and the sandbox drops that context's row once it observes the failure. If instead the sandbox expires first, the whole sandbox (and every context in it, across every binding) is deleted together, so there's nothing left to be inconsistent about.

Any request that touches the sandbox (`sandbox.interpreter.runCode`, `getInfo`, a context operation, `setEnvVars`, or a file operation) can (re)arm its Durable Object alarm; when that alarm fires without another touching request in the meantime, the sandbox is deleted exactly the way `sandbox.destroy()` deletes it. Re-arming is throttled the same way on both sides: a touching request only moves the deadline when doing so would push it more than a tenth of the TTL further out, so a busy sandbox (or interpreter) isn't rewriting its own metadata on every single request — in exchange, either side can go idle for as little as **0.9× its configured TTL** before expiring, not exactly the full TTL.

`getInfo()` reports the sandbox's own deadline as `expiresAt` (epoch milliseconds, or `null` when expiry is disabled), and a successful execution in a context reports the same value in `context.expiresAt` — both report whichever deadline is actually armed right now, which (per the throttling above) may be from an earlier request.

## Destruction

A sandbox can be destroyed explicitly at any time: the typed client's `sandbox.destroy()`. Destruction wipes storage, drops every live context's registry entry, and best-effort calls `DELETE /interpreters/<key>` on every binding a context referenced, wiping that context's memory snapshots on its runtime Worker too.

## Ruby is stateless-only

Ruby's runtime Worker always reports `contexts: false` from `GET /interpreter` — the same as any runtime Worker deployed with `--stateless`. A sandbox can still exist and hold contexts bound to other languages; `createCodeContext({ binding: "RUBY" })` simply fails, and `runCode({ binding: "RUBY" })` runs statelessly instead.

## Related resources

- [Code contexts](/concepts/code-contexts)
- [Architecture](/concepts/architecture)
- [Security model](/concepts/security)
- [Use code contexts](/stateful/code-contexts)
- [API: lifecycle](/api/lifecycle)
- [Environment variables](/configuration/environment-variables)
