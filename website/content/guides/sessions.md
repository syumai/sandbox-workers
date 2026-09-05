---
title: Sessions
description: Durable, stateful REPLs on top of the stateless execution API.
---

`POST /execute` boots a fresh Wasm instance every call: nothing persists. A **session** is the stateful alternative — a named, durable REPL backed by a Durable Object, following the split used by Cloudflare's Sandbox SDK. One execution's top-level variables, functions, classes, and imported modules are visible to the next execution in the same session, and the session also owns a writable `/workspace` directory and a `cwd` reachable from guest code and from the caller through a files API.

Sessions are supported for **JavaScript, Python, and Perl**. **Ruby is not supported** — every `/sessions/*` route on a Ruby runtime Worker answers 400 `Sessions are not supported for ruby`, because Ruby's initial memory (35.6 MiB) and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other languages use.

## Memory snapshots

A session's globals (not just its `/workspace`) survive Durable Object eviction, hibernation, and redeploys: after each execution that leaves the interpreter in a safe, resumable state, the runtime Worker takes a snapshot of the engine's linear memory and writes it to the Durable Object's own SQLite storage, alongside the workspace files. The next time the session is used — even from a brand-new Durable Object instance, in a brand-new `wrangler dev`/isolate process — the engine is restored from that snapshot instead of booting fresh, so top-level variables, functions, classes, and imported modules are exactly as a prior execution left them.

A few things follow from how this works:

- **A snapshot is skipped, never corrupted, after a trap.** Fuel exhaustion in Python and Perl, and any other unrecoverable engine error, both throw away the live interpreter; the *next* execution boots a fresh one from the most recent snapshot (or from scratch, if there is none yet) — nothing from the failed execution's globals survives, but the session keeps working. JavaScript's fuel-exhaustion interrupt is different: the interpreter is not corrupted by it, so the session stays live and stays snapshottable.
- **A snapshot is skipped, and the existing one is flagged stale, if the guest still holds an open file descriptor** when an execution finishes (for example, Python or Perl code that calls `open()` without closing the result). The execution's result is unaffected, but restoring the snapshot later would replay an older memory image than what that execution actually produced — `GET /sessions/:id` reports `snapshot.stale: true` until a later execution snapshots cleanly again.
- **Memory never shrinks.** Once a session's linear memory has grown, later executions keep paying for that page count even if they use less. `POST /sessions/:id/reset` is the way to compact: it drops both the live interpreter and the stored snapshot (keeping `/workspace` and `cwd`), so the next execution starts from a fresh, minimum-size interpreter.
- **A stored snapshot is discarded, not restored, if the engine build changed** (a redeploy with different engine code). `GET /sessions/:id` then reports `snapshot: null` until the next execution's memory image is snapshotted from scratch.
- **`Math.random()`'s sequence repeats after a restore.** A restored JavaScript engine resumes its pseudo-random generator from exactly the state it was in when the snapshot was taken, so code that calls `Math.random()` right after a restore can see the same values it would have seen right after the original snapshot. Python's `random` module is reseeded automatically after every restore, so it doesn't have this issue; Perl session code that needs fresh entropy across a restore should call `srand()` itself.

An execution that actually wrote a snapshot reports how long that took in `session.snapshotMs` (milliseconds) — useful for measuring the cost of a particular session's workload, not something callers need to act on.

## Idle expiry

A session is deleted automatically after it goes unused for a while: every request that touches it — `execute`, `GET`, `reset`, or a file operation — (re)arms a Durable Object alarm, and when that alarm fires without another touching request in the meantime, the session is deleted exactly the way `DELETE /sessions/:id` deletes it (storage wiped, live interpreter dropped).

The timeout is the runtime Worker's own `SESSION_IDLE_TTL_MS` env var (a string, since Wrangler `vars` are strings): unset or invalid falls back to 24 hours, and `"0"` disables expiry entirely (no alarm is ever armed). Set it under `vars` in the runtime Worker's `wrangler.jsonc`:

```jsonc
{
  "vars": { "SESSION_IDLE_TTL_MS": "3600000" }, // 1 hour; "0" disables expiry
}
```

`GET /sessions/:id` reports the current deadline as `expiresAt` (epoch milliseconds, or `null` when expiry is disabled), and a successful `POST /sessions/:id/execute` reports the same value in `session.expiresAt` — both reflect the alarm that request itself just (re)armed, so a caller can show "time remaining" without a separate `GET`.

## Enable sessions in your Worker

A runtime Worker that supports sessions exports a `SandboxSession` Durable Object class next to its default export. Deploying one requires a Durable Object binding and a SQLite-backed migration in the runtime Worker's own `wrangler.jsonc` — **not** in the calling application, which keeps using a plain Service Binding:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SESSIONS", "class_name": "SandboxSession" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SandboxSession"] }],
}
```

The CLI initializer (`sandbox-workers init javascript|python|perl`) and the deploy-to-Cloudflare templates already include this for the three supported languages; Ruby's output has no Durable Object binding. See [Service Bindings](/guides/service-bindings) for the full picture of what lives in the caller versus the runtime Worker.

## Use the typed client

```ts
import { createSandbox } from "@sandbox-workers/core";

const sandbox = createSandbox(env.SANDBOX);

// Stateless, unchanged:
await sandbox.runCode(code, { envVars });

// Stateful:
const session = sandbox.session("user-42");
await session.runCode(code, { envVars, cwd });
await session.info();
await session.reset();
await session.destroy();
await session.readFile(path, { encoding });
await session.writeFile(path, content, { encoding }); // string or Uint8Array
await session.listFiles(path, { recursive });
await session.deleteFile(path, { recursive, force });
await session.renameFile(from, to);
await session.mkdir(path, { recursive });
await session.exists(path);
await session.stat(path);
```

`sandbox.session(id)` validates `id` against `^[A-Za-z0-9._-]{1,128}$` (the same pattern the runtime Worker enforces) and throws synchronously if it doesn't match. Session ids are chosen by the caller and must already be tenant-scoped — the runtime does not authenticate them, so an application that accepts user input must scope or validate ids itself (for example `user-${userId}`).

`session.runCode` resolves to the same `ExecutionResult` shape as `sandbox.runCode`, plus a `session: { id, cwd, executions }` field, and — like `/execute` — always resolves rather than throwing for a guest error; check `result.error`. Binding failures and malformed responses throw `SandboxTransportError`, exactly as with the stateless client. File operations that fail (a missing path, a name collision, and so on) throw `SandboxFileError`, which carries `code` (a Node-style error code such as `ENOENT` or `EEXIST`) and `status` (the HTTP status the runtime Worker returned).

## Calling the HTTP API directly

Every route is under `/sessions/:id` on the runtime Worker (or `/languages/:language/sessions/:id` through the Playground gateway — see [API reference](/reference/api)):

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sessions/:id/execute` | `{code, envVars?, cwd?}` | The `/execute` result plus `session: {id, cwd, executions, snapshotMs?, expiresAt?}`; always 200 |
| `GET /sessions/:id` | | `{id, language, engine, cwd, createdAt, lastUsed, executions, workspace: {files, bytes}, snapshot, expiresAt}` |
| `DELETE /sessions/:id` | | `{ok: true}` — deletes storage and drops the instance |
| `POST /sessions/:id/reset` | | `{ok: true}` — drops the live instance and the stored snapshot, keeps files and `cwd` |
| `POST /sessions/:id/files` | `{op, path, newPath?, content?, encoding?, recursive?, force?}` | Per operation, below |

`snapshot` is `{build, pages, bytes, takenAt, stale}` once the session has snapshotted at least once (`pages`/`bytes` describe the stored linear-memory pages, `takenAt` is a timestamp, `stale` is `true` when the most recent execution couldn't be snapshotted — see "Memory snapshots" above), or `null` before the first snapshot or right after `reset`. `session.snapshotMs` (on the execute response) is present only on an execution that actually wrote a snapshot. `expiresAt` is the epoch-millisecond deadline of the session's idle-expiry Durable Object alarm (see "Idle expiry" above), or `null` when expiry is disabled; the execute response's `session.expiresAt` is omitted the same way.

### The files API

`op` is one of `read`, `write`, `list`, `delete`, `rename`, `mkdir`, `exists`, or `stat`. `path` (and `newPath` for `rename`) is absolute under `/workspace` or relative to the session's `cwd`; it is normalized and rejected if it would escape `/workspace`. `encoding` is `utf-8` (default) or `base64`, for `read` and `write`.

| `op` | Extra fields | Response |
| --- | --- | --- |
| `read` | `encoding?` | `{content, size, encoding, isBinary, updatedAt}` |
| `write` | `content`, `encoding?` | `{size}` |
| `list` | `recursive?` | `{entries: [{path, type, size, updatedAt}]}` |
| `delete` | `recursive?`, `force?` | `{ok: true}` |
| `rename` | `newPath` | `{ok: true}` |
| `mkdir` | `recursive?` | `{ok: true}` |
| `exists` | | `{exists}` |
| `stat` | | `{type, size, updatedAt}` |

Limits: 1 MiB per file, 16 MiB per workspace, 4096 entries. A file operation failure returns a 4xx status with `{error: {name: "FileError", code, message}}`, where `code` is one of `ENOENT` (404), `EEXIST`/`ENOTEMPTY` (409), `EFBIG`/`ENOSPC` (413), or `ENOTDIR`/`EISDIR`/`EACCES` (400). Transport and validation errors (an unknown session id shape, invalid JSON) use the same `{error: {name: "ApiError", message}}` shape as `/execute`.

## REPL semantics per language

### JavaScript

Code runs as a classic script in the session's realm, so top-level `var`, `let`, `const`, `class`, and `function` declarations persist across executions exactly as in a browser console — the completion value of the script is still the result, formatted like `/execute`. A top-level `await` is hoisted the way Node's REPL does it, so values assigned that way persist too.

`process.env` is rebuilt from `envVars` before every execution. `process.cwd()` and `process.chdir(path)` are host functions backed by the session's workspace; `chdir` is validated against `/workspace`.

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

Code runs with `exec` in a persistent `__main__` namespace. If the last statement is an expression, its value is the result, using the same `ast` split as `/execute`. `os.chdir(cwd)` runs before the body, and the final `os.getcwd()` is persisted when it is under `/workspace`. `sys.path` includes `/workspace`, so modules written there can be imported by a later execution in the same session.

### Perl

Code runs with `eval` in package `main`. Package variables declared `our`, subroutines, and loaded modules persist across executions; `my` variables are lexically scoped to the one execution that declared them and do not survive to the next. `chdir($cwd)` runs before the body and `Cwd::getcwd()` is persisted afterward.

## See also

[`docs/sessions-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sessions-design.md) in the repository is the full design document, including the Durable Object's internal storage layout and the memory-snapshot mechanism described above.
