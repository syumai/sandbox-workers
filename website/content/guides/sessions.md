---
title: Sandboxes and code contexts
description: Durable, stateful REPLs on top of the stateless execution API.
---

`POST /execute` boots a fresh Wasm instance every call: nothing persists. A **sandbox** is the stateful alternative — one Durable Object per caller-chosen id, following the split used by Cloudflare's Sandbox SDK. A sandbox owns a writable `/workspace` directory and a `cwd`, reachable from guest code and from the caller through a files API, plus one or more **code contexts**: named, durable REPLs. One execution's top-level variables, functions, classes, and imported modules are visible to the next execution in the same context; `/workspace` is shared by every context in the sandbox, so files written from one context are visible from another.

Code contexts are supported for **JavaScript, Python, and Perl**. **Ruby is not supported** — every `/sandboxes/:id/*` route on a Ruby runtime Worker answers 400 `Code contexts are not supported for ruby` (with the exception of a context-less `execute`, which runs statelessly), because Ruby's initial memory (35.6 MiB) and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other languages use.

A sandbox holds at most 8 code contexts, with one interpreter resident in memory at a time; the rest are restored from their snapshot on next use. `runCode` without a context uses (or creates) the first context whose language matches the request, so simple callers never need to think about contexts at all.

## Memory snapshots

A code context's globals (not just its sandbox's `/workspace`) survive Durable Object eviction, hibernation, and redeploys: after each execution that leaves the interpreter in a safe, resumable state, the runtime Worker takes a snapshot of the engine's linear memory and writes it to the Durable Object's own SQLite storage, alongside the workspace files. The next time that context is used — even from a brand-new Durable Object instance, in a brand-new `wrangler dev`/isolate process — the engine is restored from that snapshot instead of booting fresh, so top-level variables, functions, classes, and imported modules are exactly as a prior execution left them.

A few things follow from how this works:

- **A snapshot is skipped, never corrupted, after a trap.** Fuel exhaustion in Python and Perl, and any other unrecoverable engine error, both throw away the live interpreter; the *next* execution in that context boots a fresh one from the most recent snapshot (or from scratch, if there is none yet) — nothing from the failed execution's globals survives, but the context keeps working. JavaScript's fuel-exhaustion interrupt is different: the interpreter is not corrupted by it, so the context stays live and stays snapshottable.
- **A snapshot is skipped, and the existing one is flagged stale, if the guest still holds an open file descriptor** when an execution finishes (for example, Python or Perl code that calls `open()` without closing the result). The execution's result is unaffected, but restoring the snapshot later would replay an older memory image than what that execution actually produced — `GET /sandboxes/:id` reports that context's `snapshot.stale: true` until a later execution snapshots cleanly again.
- **Memory never shrinks.** Once a context's linear memory has grown, later executions keep paying for that page count even if they use less. Deleting the context (`DELETE /sandboxes/:id/contexts/:contextId`) and creating a new one is the way to compact: it drops both the live interpreter and the stored snapshot for that context (`/workspace` is untouched, since it belongs to the sandbox), so the next execution in the new context starts from a fresh, minimum-size interpreter.
- **A stored snapshot is discarded, not restored, if the engine build changed** (a redeploy with different engine code). `GET /sandboxes/:id` then reports that context's `snapshot: null` until the next execution's memory image is snapshotted from scratch.
- **`Math.random()`'s sequence repeats after a restore.** A restored JavaScript engine resumes its pseudo-random generator from exactly the state it was in when the snapshot was taken, so code that calls `Math.random()` right after a restore can see the same values it would have seen right after the original snapshot. Python's `random` module is reseeded automatically after every restore, so it doesn't have this issue; Perl code that needs fresh entropy across a restore should call `srand()` itself.

An execution that actually wrote a snapshot reports how long that took in `context.snapshotMs` (milliseconds) — useful for measuring the cost of a particular context's workload, not something callers need to act on.

## Idle expiry

A **whole sandbox** — all of its code contexts and its `/workspace` — is deleted automatically after it goes unused for a while: every request that touches it — `execute`, `GET`, a context operation, `setEnvVars`, or a file operation — (re)arms a Durable Object alarm, and when that alarm fires without another touching request in the meantime, the sandbox is deleted exactly the way `DELETE /sandboxes/:id` deletes it (storage wiped, live interpreter dropped).

The timeout is the runtime Worker's own `SESSION_IDLE_TTL_MS` env var (a string, since Wrangler `vars` are strings): unset or invalid falls back to 24 hours, and `"0"` disables expiry entirely (no alarm is ever armed). Set it under `vars` in the runtime Worker's `wrangler.jsonc`:

```jsonc
{
  "vars": { "SESSION_IDLE_TTL_MS": "3600000" }, // 1 hour; "0" disables expiry
}
```

`GET /sandboxes/:id` reports the current deadline as `expiresAt` (epoch milliseconds, or `null` when expiry is disabled), and a successful `POST /sandboxes/:id/execute` reports the same value in `context.expiresAt` — both reflect the alarm that request itself just (re)armed, so a caller can show "time remaining" without a separate `GET`.

## Enable sandboxes in your Worker

A runtime Worker that supports code contexts exports a `Sandbox` Durable Object class next to its default export. Deploying one requires a Durable Object binding and a SQLite-backed migration in the runtime Worker's own `wrangler.jsonc` — **not** in the calling application, which keeps using a plain Service Binding:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
}
```

The CLI initializer (`sandbox-workers init javascript|python|perl`) and the deploy-to-Cloudflare templates already include this for the three supported languages; Ruby's output has no Durable Object binding.

Alternatively, the calling application can bind directly to the runtime Worker's `Sandbox` class as a **Durable Object namespace**, with no migration of its own:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox", "script_name": "sandbox-javascript" }],
  },
}
```

See [Service Bindings](/guides/service-bindings) for the full picture of what lives in the caller versus the runtime Worker.

## Use the typed client

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.SANDBOX, "user-42");

// Default context for the runtime's language, created on first use:
await sandbox.runCode(code, { envVars });

// Explicit contexts:
const ctx = await sandbox.createCodeContext({ language, cwd, envVars });
await sandbox.runCode(code, { context: ctx, envVars });
await sandbox.listCodeContexts();
await sandbox.deleteCodeContext(ctx.id);
await sandbox.setEnvVars({ NAME: "value", OLD: undefined }); // undefined unsets

await sandbox.readFile(path, { encoding });
await sandbox.writeFile(path, content, { encoding }); // string or Uint8Array
await sandbox.listFiles(path, { recursive, includeHidden });
await sandbox.deleteFile(path, { recursive, force });
await sandbox.renameFile(from, to);
await sandbox.moveFile(from, to);
await sandbox.mkdir(path, { recursive });
await sandbox.exists(path);

await sandbox.getInfo();
await sandbox.destroy();
```

`getSandbox(target, id)` validates `id` against `^[A-Za-z0-9._-]{1,128}$` (the same pattern the runtime Worker enforces) and throws synchronously if it doesn't match; sandbox ids are chosen by the caller and must already be tenant-scoped — the runtime does not authenticate them, so an application that accepts user input must scope or validate ids itself (for example `user-${userId}`).

`sandbox.runCode` resolves to the same `ExecutionResult` shape whether or not a `context` is passed, plus a `context: {id, cwd, executions, snapshotMs?, expiresAt?}` field when running in a context (Ruby's context-less execute omits it), and — like `/execute` — always resolves rather than throwing for a guest error; check `result.error`. Binding failures and non-200 responses throw a `SandboxError` subclass (`FileNotFoundError`, `ContextNotFoundError`, `ValidationFailedError`, and so on — see [the core package](https://github.com/syumai/sandbox-workers/blob/main/packages/core/README.md#errors)).

## Calling the HTTP API directly

Every route is under `/sandboxes/:id` on the runtime Worker (or `/languages/:language/sandboxes/:id` through the Playground gateway — see [API reference](/reference/api)):

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sandboxes/:id/execute` | `{code, contextId?, language?, envVars?}` | The `/execute` result plus `context: {id, cwd, executions, snapshotMs?, expiresAt?}`; always 200 for guest errors |
| `POST /sandboxes/:id/contexts` | `{language?, cwd?, envVars?}` | `{id, language, cwd, createdAt, lastUsed}` (201) |
| `GET /sandboxes/:id/contexts` | | `{contexts: [{id, language, cwd, createdAt, lastUsed}]}` |
| `DELETE /sandboxes/:id/contexts/:contextId` | | `{success: true}`; 404 `CONTEXT_NOT_FOUND` |
| `POST /sandboxes/:id/env` | `{envVars: Record<string, string \| null>}` (`null` unsets a key) | `{success: true}` |
| `POST /sandboxes/:id/files` | `{op, path, newPath?, content?, encoding?, recursive?, force?, includeHidden?}` | Per operation, below |
| `GET /sandboxes/:id` | | `SandboxInfo` (below) |
| `DELETE /sandboxes/:id` | | `{success: true}` — deletes storage and drops every context |

`SandboxInfo` (the `GET /sandboxes/:id` response) is `{id, language, engine, createdAt, lastUsed, envVars, contexts, workspace: {files, bytes}, expiresAt}`, where each entry of `contexts` is `{id, language, cwd, createdAt, lastUsed, executions, snapshot}`. `snapshot` is `{build, pages, bytes, takenAt, stale}` once that context has snapshotted at least once (`pages`/`bytes` describe the stored linear-memory pages, `takenAt` is a timestamp, `stale` is `true` when the most recent execution couldn't be snapshotted — see "Memory snapshots" above), or `null` before its first snapshot. `context.snapshotMs` (on the execute response) is present only on an execution that actually wrote a snapshot. `expiresAt` is the epoch-millisecond deadline of the sandbox's idle-expiry Durable Object alarm (see "Idle expiry" above), or `null` when expiry is disabled; the execute response's `context.expiresAt` is omitted the same way.

### The files API

`op` is one of `read`, `write`, `mkdir`, `delete`, `rename`, `move`, `list`, or `exists`. `path` (and `newPath` for `rename`/`move`) is absolute under `/workspace`; it is normalized and rejected if it would escape `/workspace`. `encoding` is `utf-8` (default) or `base64`, for `read` and `write`. `rename` and `move` are the same operation; `move` additionally requires the destination's parent directory to exist.

| `op` | Extra fields | Response |
| --- | --- | --- |
| `read` | `encoding?` | `{success, path, content, encoding, isBinary, mimeType, size, timestamp}` |
| `write` | `content`, `encoding?` | `{success, path, timestamp}` |
| `mkdir` | `recursive?` | `{success, path, recursive, timestamp}` |
| `delete` | `recursive?`, `force?` | `{success, path, timestamp}` — a directory needs `recursive: true`; `force: true` ignores a missing path |
| `rename` / `move` | `newPath` | `{success, path, newPath, timestamp}` |
| `list` | `recursive?`, `includeHidden?` | `{success, path, files: FileInfo[], count, timestamp}` |
| `exists` | | `{success, path, exists, timestamp}` |

`FileInfo` is `{name, absolutePath, relativePath, type, size, modifiedAt, mode, permissions}`; hidden entries (name starting with `.`) are omitted from `list` unless `includeHidden` is set. Limits: 1 MiB per file, 16 MiB per workspace, 4096 entries. A file operation failure returns the `ErrorResponse` shape described in [API reference](/reference/api) (`FILE_NOT_FOUND` 404, `FILE_EXISTS` 409, `PERMISSION_DENIED` 403, `IS_DIRECTORY`/`NOT_DIRECTORY` 400, `FILE_TOO_LARGE` 413, `NO_SPACE` 507, `FILESYSTEM_ERROR` 400), with the Node-style errno in `context.errno`.

## REPL semantics per language

### JavaScript

Code runs as a classic script in the context's realm, so top-level `var`, `let`, `const`, `class`, and `function` declarations persist across executions exactly as in a browser console — the completion value of the script is still the result, formatted like `/execute`. A top-level `await` is hoisted the way Node's REPL does it, so values assigned that way persist too.

`process.env` is rebuilt from the layered env vars before every execution. `process.cwd()` and `process.chdir(path)` are host functions backed by the sandbox's workspace; `chdir` is validated against `/workspace`.

`fs` is a host-backed synchronous subset of Node's `fs`:

```js
fs.readFileSync(path, "utf8"); // string; without an encoding, a Uint8Array
fs.writeFileSync(path, data); // string or Uint8Array
fs.readdirSync(path, { withFileTypes });
fs.mkdirSync(path, { recursive });
fs.rmSync(path, { recursive, force });
fs.renameSync(from, to);
fs.existsSync(path);
fs.statSync(path); // { size, mtimeMs, isFile(), isDirectory() }
```

Errors carry the same Node-style `code` values as the HTTP files API. `import()` (and static `import` inside a module loaded through it) is served from `/workspace`: `./` and `../` specifiers resolve against the importing module, and only `.js`/`.mjs` and `.json` (with `{type: "json"}`) files are served — anything outside `/workspace` fails to resolve.

### Python

Code runs with `exec` in a persistent `__main__` namespace. If the last statement is an expression, its value is the result, using the same `ast` split as `/execute`. `os.chdir(cwd)` runs before the body, and the final `os.getcwd()` is persisted when it is under `/workspace`. `sys.path` includes `/workspace`, so modules written there can be imported by a later execution in the same context.

### Perl

Code runs with `eval` in package `main`. Package variables declared `our`, subroutines, and loaded modules persist across executions; `my` variables are lexically scoped to the one execution that declared them and do not survive to the next. `chdir($cwd)` runs before the body and `Cwd::getcwd()` is persisted afterward.

## Upgrading from sessions

Sessions created before this change are discarded — the on-disk storage format changed, and nothing is migrated. To port calling code:

- `sandbox.session(id)` → `getSandbox(env.SANDBOX, id)`, then `createCodeContext()` (or omit the context entirely and let `runCode` use the default one).
- `session.runCode(code, { envVars, cwd })` → `sandbox.runCode(code, { context, envVars })`; `cwd` is no longer a per-call option — it's a context property, set with `createCodeContext({ cwd })` and updated by the guest's own `chdir`.
- `session.info()` → `sandbox.getInfo()`.
- `session.stat(path)` is removed; use `sandbox.listFiles()` or `sandbox.exists()`.
- `session.reset()` (drop the live instance and snapshot, keep files) → delete every context with `sandbox.deleteCodeContext(id)` for each id from `sandbox.listCodeContexts()`; `/workspace` is untouched.
- `session.destroy()` → `sandbox.destroy()`.
- File methods (`readFile`, `writeFile`, `listFiles`, `deleteFile`, `renameFile`, `mkdir`, `exists`) keep the same names; `listFiles` gained `includeHidden`, and there's a new `moveFile`.
- `SandboxTransportError`/`SandboxFileError` → `SandboxError` and its subclasses (`FileNotFoundError`, `ContextNotFoundError`, and so on).
- The runtime Worker's binding is renamed `SESSIONS` → `SANDBOX`, and its Durable Object class `SandboxSession` → `Sandbox`.

## See also

[`docs/sdk-parity-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sdk-parity-design.md) in the repository is the full design document for this API surface. [`docs/sessions-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sessions-design.md) documents the Durable Object's internal storage layout and the memory-snapshot mechanism described above, which this change left unchanged apart from keying pages by context.
