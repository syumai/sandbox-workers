---
title: Environment variables
description: Guest envVars per call and per context, setEnvVars layering, per-language access, and the runtime Worker's SESSION_IDLE_TTL_MS setting.
---

Environment variables work at two layers: guest-visible `envVars`, passed into executing code, and runtime Worker `vars`, which configure the Worker itself (Wrangler's own environment variables).

## Guest environment variables

Pass `envVars` to `runCode`:

```ts
await sandbox.runCode(code, { envVars: { X: "12" } });
```

Keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`; values must be strings. A `null` or `undefined` value is skipped rather than passed through. Only the key/value pairs supplied this way are visible to guest code — nothing from the runtime Worker's own host environment leaks through.

Each language reads them differently:

| Language   | Access                |
| ---------- | --------------------- |
| JavaScript | `process.env.NAME`    |
| Python     | `os.environ["NAME"]`  |
| Perl       | `$ENV{NAME}`           |
| Ruby       | `ENV["NAME"]`          |

### Sandbox-level: `setEnvVars`

`sandbox.setEnvVars()` sets variables for every execution in the sandbox, across every context, until changed again:

```ts
await sandbox.setEnvVars({ NAME: "value", OLD: undefined }); // undefined unsets a key
```

Passing `undefined` for a key removes it rather than setting the literal string `"undefined"`.

### Context-level: `envVars` on `createCodeContext`

A code context can carry its own `envVars`, set once when the context is created:

```ts
const ctx = await sandbox.createCodeContext({ language: "python", envVars: { MODE: "test" } });
```

### Layering order

When the same key is set at more than one layer, a later source overrides an earlier one, in this order:

1. Sandbox-level (`setEnvVars`)
2. Context-level (`createCodeContext({ envVars })`)
3. Call-level (`runCode(code, { envVars })`)

An explicit `null`/`undefined` at any layer unsets that key for the merged result rather than passing the literal string through to the guest.

## Runtime Worker settings

`SESSION_IDLE_TTL_MS` configures how long a sandbox can sit idle before it, and everything in it (every code context and `/workspace`), is deleted. It is set under `vars` in the **runtime Worker's** `wrangler.jsonc` (Wrangler `vars` are always strings):

```jsonc
{
  "vars": { "SESSION_IDLE_TTL_MS": "3600000" }, // 1 hour; "0" disables expiry
}
```

Unset or invalid values fall back to the default of 24 hours. Setting it to `"0"` disables idle expiry entirely — no expiry alarm is ever armed.

## Related resources

- [Wrangler configuration](/configuration/wrangler) — where `vars` and other runtime Worker settings live.
- [Execute code](/guides/execute-code) — passing `envVars` to `runCode`.
- [Interpreter](/api/interpreter) — `createCodeContext`, `setEnvVars`, and `runCode` signatures.
- [Sandboxes](/concepts/sandboxes) — idle expiry behavior in full.
