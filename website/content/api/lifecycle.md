---
title: Lifecycle
description: Get a sandbox client, inspect its state, and destroy it.
---

Get and manage the sandbox itself: the Durable Object that owns a `/workspace` and one or more code contexts. For the contexts and code execution living inside it, see [Code interpreter](/api/interpreter); for files, see [Files](/api/files).

## Methods

### `getSandbox()`

Get a typed client for one sandbox.

```ts
function getSandbox(
  target: SandboxTarget,
  id: string,
  options?: SandboxOptions,
): Sandbox
```

**Parameters**:

- `target` — either a Service Binding (`Fetcher`-shaped) to the runtime Worker, or a Durable Object namespace bound with `script_name` to the runtime Worker's `Sandbox` class. The client detects which one it was given. See [Transport](/configuration/transport) for how each is wired up and what the client does differently for each.
- `id` — the sandbox's id, chosen by the caller. Must match `^[A-Za-z0-9._-]{1,128}$`; the same id always resolves to the same sandbox (Durable Object).
- `options` (optional):
  - `normalizeId` — lowercases `id` before validating and using it.

**Returns**: a `Sandbox` client. No network call is made yet — `getSandbox()` itself is synchronous.

`getSandbox()` throws synchronously (an `Error`, not a `SandboxError`) if `id` (after normalization, when `normalizeId` is set) doesn't match `^[A-Za-z0-9._-]{1,128}$`.

Sandbox ids are chosen by the caller and are **not authenticated by the runtime** — anyone who knows an id can reach that sandbox through the same binding. An application that accepts user input must tenant-scope or validate ids itself (for example `user-${userId}`), rather than passing raw user input straight through.

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.SANDBOX, "user-42");
```

The underlying Durable Object is created lazily on first use — `getSandbox()` returns immediately, and the sandbox comes into existence the first time a request (`runCode`, a file operation, `getInfo`, and so on) actually reaches it. It is later deleted automatically after a period of inactivity. See [Sandboxes](/concepts/sandboxes) for the full lifecycle.

### `sandbox.id`

```ts
readonly id: string
```

The sandbox's id, as passed to `getSandbox()` (lowercased first, if `normalizeId` was set).

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

Delete the sandbox: its storage, every code context, and its `/workspace`.

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
  language: string;
  engine: string;
  createdAt: string;
  lastUsed: string;
  envVars: Record<string, string>;
  contexts: Array<{
    id: string;
    language: string;
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

- `id`, `language`, `engine` — the sandbox's id and the runtime Worker's language and engine name.
- `createdAt`, `lastUsed` — ISO timestamps for the sandbox itself.
- `envVars` — the env vars currently layered onto the sandbox by `setEnvVars()`.
- `contexts` — one entry per code context. `executions` is the number of times that context has run code. `snapshot` describes the context's stored memory snapshot: `pages`/`bytes` are the size of the live linear memory, `storedBytes` is the actual on-disk footprint — always a multiple of 1 MiB and at least `bytes`, since snapshots are stored in 1 MiB chunks and a chunk containing even one non-zero page is written whole — `takenAt` is when it was written, and `stale: true` means the most recent execution couldn't be snapshotted cleanly; `snapshot` is `null` before that context's first snapshot. See [Code contexts](/concepts/code-contexts) for how and when snapshots are taken.
- `workspace` — the number of files and total bytes currently stored under `/workspace`.
- `expiresAt` — the epoch-millisecond deadline of the sandbox's idle-expiry alarm, or `null` when expiry is disabled for the runtime Worker. See [Sandboxes](/concepts/sandboxes) for the expiry behavior and [Environment variables](/configuration/environment-variables) for the `SESSION_IDLE_TTL_MS` setting that controls it.
