---
title: Security model
description: Isolation guarantees, denied capabilities, and what a public caller must still implement.
---

sandbox-workers isolates guest code with Wasm, but it does not implement authentication, rate limiting, or tenant isolation on your behalf. This page describes what the platform guarantees and what stays the caller's responsibility.

## Wasm isolation

Every execution boots a fresh Wasm instance with fresh linear memory: nothing from a previous stateless call is retained, and nothing another sandbox or context has done is visible. See [Architecture](/concepts/architecture) and [Runtime engines](/concepts/runtimes) for how this is enforced per language.

## What the guest can see

Only the key/value pairs supplied in `envVars` are ever exposed to guest code (as `process.env`, `os.environ`, `%ENV`, or `ENV`, depending on the language). Host environment variables and secrets are never passed through, no matter what the runtime Worker itself is configured with.

## Denied capabilities

Unimplemented host capabilities fail explicitly rather than silently succeeding. The JavaScript host, for example, denies every Wasm import it does not explicitly implement — randomness, clocks, and the fuel/interrupt hooks used for metering are the only ones it provides, and the never-used `thread-spawn`/`go_host_call` bridges are stubbed out. Across every engine, outbound network access, host files, sockets, and process creation are unavailable to guest code (see [Runtime engines](/concepts/runtimes)).

`SharedArrayBuffer` and `Atomics` are deleted from the JavaScript guest's `globalThis` before any code runs, even though the engine's linear memory is declared shared — that declaration exists only for a thread-spawn path this sandbox never enables. Ruby's JavaScript bridge is disabled entirely.

## Workspace confinement

A sandbox's file operations are confined to `/workspace`: paths are normalized, and any path that would resolve outside `/workspace` is rejected rather than followed.

## No public URL

Runtime Workers are deployed with `workers_dev` and `preview_urls` both set to false, so they have no public route at all. The only way to reach one is a Worker holding a Service Binding (or a Durable Object namespace binding) to it — see [Configuration: wrangler.jsonc](/configuration/wrangler). A private runtime Worker does not, by itself, secure an unrestricted public caller in front of it.

## What the caller is responsible for

If your application accepts code, file content, or sandbox ids from end users, the runtime Worker will not protect you from:

- **Authentication and authorization** — deciding who is allowed to call your Worker at all.
- **Rate limiting** — the runtime enforces per-execution fuel, memory, and output limits (see [Limits](/platform/limits)), not per-caller request rates.
- **Input validation** — the runtime does not authenticate a sandbox id, so if it were exposed directly to user input, one user could reach another user's sandbox.
- **Tenant-scoping sandbox ids** — a sandbox id should be derived from an authenticated identity, for example `user-${userId}`, rather than accepted verbatim from the request.

Apply these at the boundary where your application accepts untrusted input, before it ever reaches a runtime Worker.

## The Playground has none of this

The Playground gateway that ships with this repository is a demonstration: it has no authentication, no rate limiting, and no per-user id scoping. Treat it as a local development and evaluation tool, not as a template for a public-facing deployment. The public Playground deployment does disable the File API (`SANDBOX_FILE_API=disabled`, see [Environment variables](/configuration/environment-variables#sandbox_file_api--your-own-worker)), so nothing anyone writes to `/workspace` there is stored — but that's a mitigation for one specific risk, not a substitute for the items above.

## Related resources

- [Architecture](/concepts/architecture)
- [Sandbox lifecycle](/concepts/sandboxes)
- [Runtime engines](/concepts/runtimes)
- [Configuration: wrangler.jsonc](/configuration/wrangler)
- [Limits](/platform/limits)
