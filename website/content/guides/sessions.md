---
title: Sessions
description: Durable, stateful REPLs on top of the stateless execution API.
---

`POST /execute` boots a fresh Wasm instance every call: nothing persists. A **session** is the stateful alternative — a named, durable REPL backed by a Durable Object, following the split used by Cloudflare's Sandbox SDK. One execution's top-level variables, functions, classes, and imported modules are visible to the next execution in the same session, and the session also owns a writable `/workspace` directory and a `cwd` reachable from guest code and from the caller through a files API.

Sessions are supported for **JavaScript, Python, and Perl**. **Ruby is not supported** — every `/sessions/*` route on a Ruby runtime Worker answers 400 `Sessions are not supported for ruby`, because Ruby's initial memory (35.6 MiB) and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other languages use.

## Current phase: in-memory only

This is phase 1 of the durable sessions feature (see the design document referenced below). A session's globals and workspace persist only while its Durable Object instance stays live in memory — repeated calls in quick succession see the same state. Memory snapshotting to survive Durable Object eviction, hibernation, and redeploys is a later phase; until then, an evicted session starts over with an empty workspace and fresh interpreter state the next time it is used. The Playground does not yet expose a session mode; that is also a later phase.

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

const sandbox = createSandbox(env.SANDBOX, "python");

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
| `POST /sessions/:id/execute` | `{code, envVars?, cwd?}` | The `/execute` result plus `session: {id, cwd, executions}`; always 200 |
| `GET /sessions/:id` | | `{id, language, engine, cwd, createdAt, lastUsed, executions, workspace: {files, bytes}, snapshot: null}` |
| `DELETE /sessions/:id` | | `{ok: true}` — deletes storage and drops the instance |
| `POST /sessions/:id/reset` | | `{ok: true}` — drops the live instance, keeps files and `cwd` |
| `POST /sessions/:id/files` | `{op, path, newPath?, content?, encoding?, recursive?, force?}` | Per operation, below |

`snapshot` is always `null` in this phase; a populated `{pages, bytes, build}` object is a later phase.

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

[`docs/sessions-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sessions-design.md) in the repository is the full design document, including the Durable Object's internal storage layout and the memory-snapshot mechanism planned for phase 2.
