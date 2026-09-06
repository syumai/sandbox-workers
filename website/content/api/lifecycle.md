---
title: Lifecycle
description: Get a sandbox client, inspect its state, and destroy it.
---

**Mode:** stateful only — requires the `Sandbox` Durable Object. See [Stateful mode](/stateful).

Get and manage the sandbox itself: the `Sandbox` Durable Object, hosted by **your own** Worker, that owns a `/workspace` and one or more code contexts. For the contexts and code execution living inside it, see [Code interpreter](/api/interpreter); for files, see [Files](/api/files).

## Export the Durable Object class

`Sandbox` is a class exported by `@sandbox-workers/core`. Re-export it from your Worker's entry point and bind it with `durable_objects`:

```ts
export { Sandbox } from "@sandbox-workers/core";
```

```jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
}
```

See [Configuration: wrangler.jsonc](/configuration/wrangler) for the complete caller configuration, including the Service Bindings to runtime Workers that `createCodeContext({ binding })` resolves by name.

## Methods

### `getSandbox()`

Get a typed client for one sandbox.

```ts
function getSandbox<Env = AnyEnv>(
  namespace: SandboxNamespace,
  id: string,
  options?: SandboxOptions,
): SandboxClient<ServiceBindingName<Env>>
```

**Parameters**:

- `namespace` — a Durable Object namespace bound to your own `Sandbox` class (the one re-exported above), for example `env.Sandbox`. `getSandbox()` throws synchronously (a plain `Error`, not a `SandboxError`) unless `namespace.idFromName` is a real Durable Object namespace method — a Service Binding (`Fetcher`) is rejected, since there is no runtime-Worker transport for `getSandbox` any more.
- `id` — the sandbox's id, chosen by the caller. Must match `^[A-Za-z0-9._-]{1,63}$`, must not start or end with a hyphen, and must not be one of the reserved names `www`, `api`, `admin`, `root`, `system`, `cloudflare`, `workers` (checked case-insensitively); the same id always resolves to the same sandbox (Durable Object).
- `options` (optional):
  - `normalizeId` — lowercases `id` before validating and using it.

**Returns**: a `SandboxClient`. No network call is made yet — `getSandbox()` itself is synchronous.

`getSandbox` takes an optional `Env` type parameter. Pass your Worker's own `Env` type — `getSandbox<Env>(env.Sandbox, id)` — and every `binding` option on `sandbox.interpreter` (see [Code interpreter](/api/interpreter)) is narrowed to `ServiceBindingName<Env>`, the names of the Service Bindings (values with a `fetch` method) in `Env`. A misspelled binding name, or the `Sandbox` namespace itself, becomes a compile-time error instead of a runtime one. This is type-only: the Durable Object still validates the binding name at runtime regardless of whether `Env` was given. Omit `Env` and `binding` stays `string`, exactly as before this type parameter existed.

```ts
interface Env {
  Sandbox: DurableObjectNamespace;
  PYTHON: Fetcher;
}

const sandbox = getSandbox<Env>(env.Sandbox, "user-42");
await sandbox.interpreter.createCodeContext({ binding: "PYTHON" }); // ok
await sandbox.interpreter.createCodeContext({ binding: "PYTHONN" }); // type error
```

`getSandbox()` throws synchronously if `id` (after normalization, when `normalizeId` is set) fails any of the checks above. The same validation is exported standalone as `validateSandboxId(id)`.

Sandbox ids are chosen by the caller and are **not authenticated by the runtime** — anyone who can reach your Worker with a given id reaches that sandbox. An application that accepts user input must tenant-scope or validate ids itself (for example `user-${userId}`), rather than passing raw user input straight through.

```ts
import { getSandbox } from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.Sandbox, "user-42");
```

The underlying Durable Object is created lazily on first use — `getSandbox()` returns immediately, and the sandbox comes into existence the first time a request (`sandbox.interpreter.runCode`, a file operation, `getInfo`, and so on) actually reaches it. It is later deleted automatically after a period of inactivity. See [Sandboxes](/concepts/sandboxes) for the full lifecycle.

### `sandbox.id`

```ts
readonly id: string
```

The sandbox's id, as passed to `getSandbox()` (lowercased first, if `normalizeId` was set).

### `sandbox.interpreter`

```ts
readonly interpreter: CodeInterpreter
```

Always present — there is no attach step or subclass. See [Code interpreter](/api/interpreter).

### `sandbox.getInfo()`

Fetch the sandbox's current state.

```ts
await sandbox.getInfo(): Promise<SandboxInfo>
```

**Parameters**: none.

**Returns**: `Promise<SandboxInfo>` — see [Types](#types) below.

```ts
const info = await sandbox.getInfo();
console.log(info.contexts.length, info.workspace.bytes, info.expiresAt);
```

### `sandbox.destroy()`

Delete the sandbox: its storage, every code context (best-effort `DELETE /interpreters/<key>` on every runtime Worker a context referenced), and its `/workspace`.

```ts
await sandbox.destroy(): Promise<void>
```

**Parameters**: none.

**Returns**: `Promise<void>`.

```ts
await sandbox.destroy();
```

This is permanent and immediate — it does the same thing as the sandbox's idle-expiry alarm firing, just on demand.

## Types

### `SandboxInfo`

The shape returned by `sandbox.getInfo()`:

```ts
interface SandboxInfo {
  id: string;
  createdAt: string;
  lastUsed: string;
  envVars: Record<string, string>;
  contexts: Array<{
    id: string;
    binding: string;
    language: string;
    engine: string;
    cwd: string;
    createdAt: string;
    lastUsed: string;
    executions: number;
    snapshot: {
      build: string;
      pages: number;
      bytes: number;
      storedBytes: number;
      takenAt: string;
      stale: boolean;
    } | null;
  }>;
  workspace: { files: number; bytes: number };
  expiresAt: number | null;
}
```

- `id` — the sandbox's id. There is no sandbox-level `language`/`engine` any more — a sandbox has no single language; each context reports its own.
- `createdAt`, `lastUsed` — ISO timestamps for the sandbox itself.
- `envVars` — the env vars currently layered onto the sandbox by `setEnvVars()`.
- `contexts` — one entry per code context, across every binding. `binding` is the Service Binding name it was created with; `language`/`engine` come from that binding's runtime Worker. `executions` is the number of times that context has run code. `snapshot` describes the context's stored memory snapshot on its runtime Worker: `pages`/`bytes` are the size of the live linear memory, `storedBytes` is the actual on-disk footprint — always a multiple of 1 MiB and at least `bytes`, since snapshots are stored in 1 MiB chunks and a chunk containing even one non-zero page is written whole — `takenAt` is when it was written, and `stale: true` means the most recent execution couldn't be snapshotted cleanly; `snapshot` is `null` before that context's first snapshot. See [Code contexts](/concepts/code-contexts) for how and when snapshots are taken.
- `workspace` — the number of entries (files and directories) and total bytes currently stored under `/workspace`.
- `expiresAt` — the epoch-millisecond deadline of the sandbox's idle-expiry alarm, or `null` when expiry is disabled. See [Sandboxes](/concepts/sandboxes) for the expiry behavior and [Environment variables](/configuration/environment-variables) for the `SANDBOX_IDLE_TTL_MS` setting that controls it.
