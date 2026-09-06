---
title: Troubleshooting
description: Diagnose deployment, binding, and execution failures.
---

## Deploy button shows a missing repository

Cloudflare's button requires a public repository. Confirm that the template exists on the referenced branch and the source repository is public. Private GitHub access in your browser does not give anonymous Workers Builds downloads access. See [Deploy a runtime Worker](/guides/deploy) for the expected flow.

## Source checksum mismatch

Do not bypass verification. Confirm that `runtime-source.json` points to the intended immutable commit and that its digest was calculated from that exact archive. Update the pin and digest together only after reviewing the new source.

## Build cannot find a workspace package

Deploy the complete isolated `templates/<language>` directory. Do not point a button directly at `packages/<language>`: it depends on build-time workspace source. For npm-based deployment, wait for publication or install a locally packed runtime. See [Deploy a runtime Worker](/guides/deploy) for the deploy-button and CLI paths.

## The runtime has no public URL

This is expected. Public and preview URLs are disabled. Call it through a Service Binding in another Worker — see [Wrangler configuration](/configuration/wrangler).

## Binding unavailable or wrong language

Check the deployed Worker name and account against your [Wrangler configuration](/configuration/wrangler). In local development, ensure the engine's Wrangler process is running. A Service Binding always targets exactly one runtime Worker — there is no `language` field in the request to route it elsewhere. If you need another language, bind to that runtime's Worker (or, on the Playground gateway, call `/execute/<language>`).

## `Unknown binding 'X'`

`createCodeContext({ binding })` (or `runCode({ binding })`) named a binding that either doesn't exist in your `env` or doesn't match `/^[A-Za-z_][A-Za-z0-9_]*$/`. Check the `binding` name against the `services` entries in your own `wrangler.jsonc` (see [Bindings](/configuration/bindings)) — it must match exactly, including case.

## `Binding 'X' is not a sandbox-workers runtime Worker`

The named binding exists but either has no `fetch` method (for example, you passed `env.Sandbox` itself, or a non-Service-Binding value) or its `GET /interpreter` response didn't parse as `{ language, engine, contexts }`. Make sure the binding points at a `@sandbox-workers/<language>` Worker, not some other service, and that both Workers are deployed from compatible versions.

## Code context not found after the runtime Worker's interpreter expired

`runCode` against an existing context throws `ContextNotFoundError`, even though `sandbox.getInfo()` still lists the context. This means the runtime Worker's `Interpreter` Durable Object expired (`INTERPRETER_IDLE_TTL_MS`) before the sandbox's own idle timer (`SANDBOX_IDLE_TTL_MS`) did, so the memory snapshot backing that context is gone while the sandbox's registry hadn't caught up yet. The sandbox drops the context's row once it observes this failure — create a new context to continue. To prevent this going forward, set `INTERPRETER_IDLE_TTL_MS` to at least `SANDBOX_IDLE_TTL_MS` (see [Sandboxes](/concepts/sandboxes) and [Environment variables](/configuration/environment-variables)).

## Mismatched idle TTLs

If sandboxes seem to lose context state well before your configured `SANDBOX_IDLE_TTL_MS`, check the runtime Worker's own `INTERPRETER_IDLE_TTL_MS` — it defaults to 24 hours independently of whatever you set on the caller side, and a shorter value there (for example, a Playground-style deployment left at its short default) expires interpreters first. Set both explicitly and keep the runtime Worker's value at least as large as the caller's.

## Execution fuel exhausted

Reduce computation or imported libraries. Fuel includes interpreter initialization. Loops, recursion, and expensive engine operations consume the budget. Retrying unchanged code does not increase it.

## Unsupported Python module

This build cannot initialize `_decimal` because mpdecimal host imports are unresolved. `decimal`, `fractions`, and `statistics` are consequently unsupported. Installing pip packages or arbitrary native extensions is not supported.

## Ruby JavaScript bridge is disabled

`JS.global` and related bridge functions are intentionally blocked to keep guest code from accessing the Worker host. Pass the data you need with `envVars`.

## Production CPU limit exceeded

Use a Paid plan and inspect its CPU configuration. Local wall-clock timings do not predict production CPU billing. The 64 MiB bundle size limit is separate from CPU and total isolate memory.
