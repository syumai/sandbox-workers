---
title: Environment variables
description: Guest envVars per call and per context, setEnvVars layering, per-language access, and the SANDBOX_IDLE_TTL_MS / INTERPRETER_IDLE_TTL_MS settings.
---

Environment variables work at two layers: guest-visible `envVars`, passed into executing code, and Worker `vars`, which configure a Worker itself (Wrangler's own environment variables) — and on this side, there are two separate idle-TTL settings, one per Worker.

## Guest environment variables

`envVars` works the same way in both modes — pass it as a call option. In stateless mode:

```ts
import { runCode } from "@sandbox-workers/core";

await runCode(env.PYTHON, code, { envVars: { X: "12" } });
```

In stateful mode:

```ts
await sandbox.interpreter.runCode(code, { envVars: { X: "12" } });
```

Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`; values must be strings. A `null` or `undefined` value is skipped rather than passed through. Only the key/value pairs supplied this way — merged across the layers below in stateful mode — are visible to guest code; nothing from either Worker's own host environment leaks through.

Each language reads them differently:

| Language   | Access                |
| ---------- | --------------------- |
| JavaScript | `process.env.NAME`    |
| Python     | `os.environ["NAME"]`  |
| Perl       | `$ENV{NAME}`           |
| Ruby       | `ENV["NAME"]`          |

### Sandbox-level: `setEnvVars` (stateful mode only)

`sandbox.setEnvVars()` sets variables for every execution in the sandbox, across every context and every binding, until changed again:

```ts
await sandbox.setEnvVars({ NAME: "value", OLD: undefined }); // undefined unsets a key
```

Passing `undefined` for a key removes it rather than setting the literal string `"undefined"`.

### Context-level: `envVars` on `createCodeContext` (stateful mode only)

A code context can carry its own `envVars`, set once when the context is created:

```ts
const ctx = await sandbox.interpreter.createCodeContext({ binding: "PYTHON", envVars: { MODE: "test" } });
```

### Layering order

When the same key is set at more than one layer, a later source overrides an earlier one, in this order:

1. Sandbox-level (`setEnvVars`)
2. Context-level (`createCodeContext({ envVars })`)
3. Call-level (`runCode(code, { envVars })`)

An explicit `null`/`undefined` at any layer unsets that key for the merged result rather than passing the literal string through to the guest. This full merge happens in the `Sandbox` Durable Object, which sends the flat, already-merged result to the runtime Worker.

## Two idle-TTL settings, on two Workers (stateful mode only)

Both settings below apply only to stateful mode: a stateless call has no sandbox and no code context to expire. Because a sandbox and a code context's interpreter live in different Durable Objects — possibly in Workers you deployed independently — there are two separate settings:

### `SANDBOX_IDLE_TTL_MS` — your own Worker

Configures how long a sandbox — every code context's registry entry plus `/workspace` — can sit idle before your `Sandbox` Durable Object deletes it:

```jsonc
// your wrangler.jsonc
{
  "vars": { "SANDBOX_IDLE_TTL_MS": "86400000" }, // 24 hours (the default); "0" disables expiry
}
```

### `INTERPRETER_IDLE_TTL_MS` — each runtime Worker

Configures how long a runtime Worker's `Interpreter` Durable Object keeps a given sandbox's contexts' memory snapshots before wiping them:

```jsonc
// this runtime Worker's wrangler.jsonc
{
  "vars": { "INTERPRETER_IDLE_TTL_MS": "3600000" }, // 1 hour; "0" disables expiry
}
```

Both default to 24 hours (Wrangler `vars` are always strings; unset or invalid values fall back to the default), and both treat `"0"` as "never expire."

**Set `INTERPRETER_IDLE_TTL_MS` to at least `SANDBOX_IDLE_TTL_MS`.** If a runtime Worker's interpreter expires first, its memory snapshots are gone while the sandbox's registry still lists the context as live — the next `runCode` against it fails with `ContextNotFoundError` even though `sandbox.getInfo()` still shows the context. See [Sandboxes](/concepts/sandboxes) for the full idle-expiry behavior on both sides.

## Related resources

- [Wrangler configuration](/configuration/wrangler) — where `vars` and other Worker settings live.
- [Execute code](/stateless/execute-code) — passing `envVars` to `runCode`.
- [Code interpreter](/api/interpreter) — `createCodeContext`, `setEnvVars`, and `runCode` signatures.
- [Sandboxes](/concepts/sandboxes) — idle expiry behavior in full, including what happens when the timers mismatch.
