---
title: Sandbox lifecycle
description: How sandboxes are created, what persists, idle expiry, and destruction.
---

A **sandbox** is the stateful alternative to a stateless `/execute` call: one Durable Object per caller-chosen id, inside the runtime Worker. A sandbox owns a writable `/workspace` directory and one or more [code contexts](/concepts/code-contexts) — named, durable REPLs that keep an interpreter's globals alive between executions.

## Creation

A sandbox is created the first time a request touches its id — there is no separate "create sandbox" call. The caller picks the id (for example `user-42`); the runtime Worker does not authenticate it, so an application that accepts user input is responsible for scoping ids to a tenant (see [Security model](/concepts/security)).

## What persists, and what doesn't

- **`/workspace`** is shared by every context in the sandbox: files written from one context are visible from another, and they survive across executions, redeploys, and Durable Object eviction or hibernation.
- **A code context's globals** (top-level variables, functions, classes, imported modules) persist the same way, through the memory-snapshot mechanism described in [Code contexts](/concepts/code-contexts) — not by keeping the interpreter resident, but by restoring it from a stored snapshot.
- Nothing persists for **stateless execution**: a `runCode` call made without a context (or a plain `/execute` request) still boots a fresh Wasm instance every time, the same as calling a runtime Worker directly. Stateless `runCode` on a sandbox uses the sandbox's default context selection logic, but the execution itself has no memory of any prior call outside that context.

## Idle expiry

A whole sandbox — every code context plus its `/workspace` — is deleted automatically after it goes unused. Any request that touches the sandbox (`execute`, `GET`, a context operation, `setEnvVars`, or a file operation) (re)arms a Durable Object alarm; when that alarm fires without another touching request in the meantime, the sandbox is deleted exactly the way `DELETE /sandboxes/:id` deletes it.

The timeout defaults to 24 hours and is configured per runtime Worker with the `SESSION_IDLE_TTL_MS` environment variable; setting it to `"0"` disables expiry entirely, so no alarm is ever armed. See [Environment variables](/configuration/environment-variables) for how to set it.

`GET /sandboxes/:id` reports the current deadline as `expiresAt` (epoch milliseconds, or `null` when expiry is disabled), and a successful execution reports the same value in `context.expiresAt` — both reflect the alarm that request itself just (re)armed.

## Destruction

A sandbox can be destroyed explicitly at any time: the typed client's `sandbox.destroy()`, or `DELETE /sandboxes/:id` over HTTP. Destruction wipes storage and drops every live context and interpreter for that sandbox.

## Ruby has no sandboxes

Code contexts — and therefore sandboxes as a stateful concept — are supported for JavaScript, Python, and Perl only. Ruby's runtime Worker exports no `Sandbox` Durable Object, so every `/sandboxes/:id/*` route on it is rejected; Ruby only supports the stateless, context-less execution contract.

## Related resources

- [Code contexts](/concepts/code-contexts)
- [Architecture](/concepts/architecture)
- [Security model](/concepts/security)
- [Use code contexts](/guides/code-contexts)
- [API: lifecycle](/api/lifecycle)
- [Environment variables](/configuration/environment-variables)
