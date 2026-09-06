# Durable sandbox sessions: design

Status: design accepted 2026-09-05 (revised the same day: no `state` API, REPL
semantics through memory snapshots, File API built on spidermonkey-wasm host
functions). **Superseded 2026-09-06 by `docs/sdk-parity-design.md`**: the API
surface described below (`sandbox.session(id)`, `/sessions/:id/...`,
`SandboxSession`, `SESSIONS`) has been replaced by `getSandbox` and code
contexts (`/sandboxes/:id/...`, `Sandbox`, `SANDBOX`). The storage and
memory-snapshot mechanics documented here — the Durable Object tables, the
linear-memory snapshot format, idle expiry — are unchanged and still apply;
only the `pages` table gained a context column, keying each stored snapshot
page by context id instead of by session. **Further amended 2026-09-06 by
`docs/snapshot-cost-design.md`**: the `pages` table (one row per changed
64 KiB page) was replaced by a `chunks` table (one row per changed 1 MiB
unit), the per-context `snapshot` record moved from its own `meta` key into
the context's own row, and `lastUsed`/the expiry alarm are now throttled
instead of rewritten on every touching request — see that document for the
row-cost rationale; the storage table below reflects the current
(post-amendment) shape. This document is the specification
for the session layer that keeps sandbox state in Durable Objects. It follows
the split used by Cloudflare's Sandbox SDK: a session is a Durable Object that
owns durable state, while the interpreter instance held in memory is a cache
that can disappear at any time.

## Goals

- A caller runs scripts repeatedly in one named session and the interpreter
  behaves like a REPL: top-level variables, functions, classes, and imported
  modules defined by one execution are visible to the next, and they survive
  Durable Object eviction, hibernation, and redeploys.
- The execution contract is the same as `POST /execute`: code is a script, the
  value of the last top-level expression is the result, `envVars` supply data.
  The only difference is that globals persist.
- Every session also owns a writable `/workspace` directory and a `cwd`,
  reachable from guest code and from the caller through a files API.
- The stateless `POST /execute` keeps its fresh-instance-per-request guarantee.
- Callers keep using a Service Binding to the runtime Worker. No Durable
  Object binding is needed in the calling application.

## Language coverage

| Language | REPL persistence | Mechanism | `/workspace` from guest |
| --- | --- | --- | --- |
| JavaScript | yes | linear-memory snapshot of spidermonkey-wasm | host functions (`fs`, `process`), `import()` via the module loader |
| Python | yes | linear-memory snapshot | WASI preopen, standard `open`, `os`, `pathlib` |
| Perl | yes (`our` variables; `my` is lexical to one execution) | linear-memory snapshot | WASI preopen |
| Ruby | not supported | initial memory is 35.6 MiB and `RubyVM` keeps host-side state | not applicable |

`POST /sessions/...` for Ruby answers 400 `Sessions are not supported for ruby`.

## Non-goals (for now)

- Streaming output, file watching, Git, R2 mounts, background processes.
- Sharing a workspace between sessions.
- A canonical baseline image for page diffing (see "Snapshot size").

## Trust model

A session is one trust domain (one user or one agent). Executions in the same
session may observe and interfere with each other by design; the host boundary
(the WASI allowlist, host-function allowlist, fuel, the memory cap) is
unchanged. Sessions never share a Wasm instance, and nothing session-specific
may live in module scope, because Durable Objects of one class can share an
isolate. Session ids are chosen by the caller and must already be
tenant-scoped; the runtime does not authenticate.

## HTTP API of a runtime Worker

All routes are under `/sessions/:id` where `id` matches `^[A-Za-z0-9._-]{1,128}$`.
Bodies and responses are JSON. Transport errors use `errorResponse`.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sessions/:id/execute` | `{code, envVars?, cwd?}` | The `/execute` result object plus `session: {id, cwd, executions}`; always 200 |
| `GET /sessions/:id` | | `{id, language, engine, cwd, createdAt, lastUsed, executions, workspace: {files, bytes}, snapshot: {pages, bytes, build} \| null}` |
| `DELETE /sessions/:id` | | `{ok: true}`; deletes storage and drops the instance |
| `POST /sessions/:id/reset` | | Drops the snapshot and the live instance, keeps files and `cwd` |
| `POST /sessions/:id/files` | `{op, path, newPath?, content?, encoding?, recursive?}` | Per op, below |

File operations. `op` is `read`, `write`, `list`, `delete`, `rename`, `mkdir`,
`exists`, or `stat`. `path` is absolute under `/workspace` or relative to the
session `cwd`; it is normalized and rejected if it escapes `/workspace`.
`encoding` is `utf-8` (default) or `base64`. `read` returns
`{content, size, encoding, isBinary, updatedAt}`; `list` returns
`{entries: [{path, type, size, updatedAt}]}` and accepts `recursive`; `write`
returns `{size}`; `exists` returns `{exists}`; `stat` returns
`{type, size, updatedAt}`. Limits: 1 MiB per file, 16 MiB per workspace,
4096 entries.

The gateway (`src/index.ts`) forwards `/languages/:language/sessions/:id/...`
to the runtime binding for `:language` as `/sessions/:id/...`.

## Typed client (`@sandbox-workers/core`)

```ts
const sandbox = createSandbox(env.SANDBOX);
await sandbox.runCode(code, { envVars });          // unchanged, stateless

const session = sandbox.session("user-42");
await session.runCode(code, { envVars, cwd });     // REPL semantics
await session.info();
await session.reset();
await session.destroy();
await session.readFile(path, { encoding });
await session.writeFile(path, content, { encoding });   // string or Uint8Array
await session.listFiles(path, { recursive });
await session.deleteFile(path); await session.renameFile(from, to);
await session.mkdir(path); await session.exists(path); await session.stat(path);
```

Method names follow the Sandbox SDK so code written against it ports with few
changes.

## Guest contract

### JavaScript

Code is evaluated as a classic script in the session's realm. Top-level
`var`, `let`, `const`, `class`, and `function` declarations therefore persist
across executions, exactly as in a browser console. The completion value of the
script is the result, formatted like `/execute`. When the script contains a
top-level `await`, the host transform (acorn) rewrites it the way Node's REPL
does: top-level declarations are hoisted to `var` declarations on the global
object and the body runs inside an async function, so the values still persist.

`process.env` is rebuilt from `envVars` before each execution. `process.cwd()`
and `process.chdir(path)` are host functions; `chdir` is validated against
`/workspace`.

`fs` is a host-backed synchronous subset of Node's `fs`:

```js
fs.readFileSync(path, "utf8")                 // string; without an encoding → Uint8Array
fs.writeFileSync(path, data)                  // string or Uint8Array
fs.readdirSync(path, { withFileTypes })
fs.mkdirSync(path, { recursive })
fs.rmSync(path, { recursive, force })
fs.renameSync(from, to)
fs.existsSync(path)
fs.statSync(path)                             // { size, mtimeMs, isFile(), isDirectory() }
```

Errors carry Node-style `code` values (`ENOENT`, `EEXIST`, `EISDIR`,
`ENOTDIR`, `ENOTEMPTY`, `EFBIG`, `ENOSPC`, `EACCES`). Binary data crosses the
host boundary as base64 inside the value encoding and is converted to
`Uint8Array` in the prelude, so no engine export is re-entered from inside a
host call.

`import()` (and static `import` in modules loaded through it) is served from
`/workspace` by the engine's module loader hook: the host answers the reserved
`module-load` call with the file's source, resolving `./` and `../` against the
importing module. Only JavaScript (`.js`, `.mjs`) and JSON (`with {type: "json"}`)
modules are served; anything outside `/workspace` fails `module not registered`.

### Python

Code is executed with `exec` in a persistent module namespace (`__main__`).
If the last statement is an expression, its value is the result (the same
`ast` split as `/execute`). `os.chdir(cwd)` runs before the body, and the
final `os.getcwd()` is persisted when it lies under `/workspace`. `sys.path`
includes `/workspace`, so modules written there can be imported. `random` is
re-seeded after a restore.

### Perl

Code is evaluated with `eval` in package `main`. Package variables (`our`),
subroutines, and loaded modules persist; `my` variables do not, and the docs
say so. `chdir($cwd)` runs before the body, `Cwd::getcwd()` is persisted.

## Durable Object

`SandboxSession` is exported by the JavaScript, Python, and Perl packages next
to the default Worker and is generic over the language runtime through a small
`Engine` interface:

```ts
interface Engine {
  language: string;
  engine: string;                       // human-readable engine string
  build: string;                        // sha256 of dist/engine.wasm, from build time
  boot(host: Host): Instance;           // fresh interpreter (+ prelude for JavaScript)
  restore(host: Host, snapshot: Snapshot): Instance;   // memory copy, no re-init
  execute(instance, payload, session): Result;         // runs the language wrapper
  canSnapshot(instance, host): boolean; // false after a trap or with guest fds still open
}
```

`Host` is created by `createWasi` with the preopens `/stdlib` (Python, Perl),
`/dev`, and the writable `/workspace` whose tree comes from
`runtime/workspace.mjs`. The preopen order is fixed and part of the snapshot
contract because wasi-libc records preopen fd numbers in linear memory.

`runtime/workspace.mjs` is the single implementation of the workspace: an
in-memory tree built from the WASI shim's `Directory` and `File` classes, path
normalization against a `cwd`, the operations listed above with their limits
and error codes, content hashing for change detection, and load/save against
Durable Object storage. WASI languages mount the tree directly; the JavaScript
host functions, the module loader, and the HTTP files API call the same
operations.

Storage (SQLite-backed Durable Object; `new_sqlite_classes` migration):

| Key or table | Content |
| --- | --- |
| `meta` | `{id, language, build, cwd, createdAt, lastUsed, executions, lifetime}` |
| `files` table | `path TEXT PRIMARY KEY, data BLOB, updated_at INTEGER` |
| `chunks` table | `context_id TEXT, chunk INTEGER, data BLOB, PRIMARY KEY (context_id, chunk)) WITHOUT ROWID` (1 MiB chunks of 16 pages each, stored raw — see `runtime/snapshot.mjs`'s "stored RAW, not deflated" note; unchanged by this amendment, only the write unit grew from one page to one chunk; see `docs/snapshot-cost-design.md`) |
| `snapshot` | `{build, pages, bytes, storedBytes, handle, extra}`, embedded in the owning context's own row rather than a separate key; `extra` holds engine integers such as the interrupt addresses |

`lifetime` is rotated on `DELETE` so in-flight work started before a destroy
cannot write into the new session (the Sandbox SDK's lifetime-id idea).

Request handling inside the Durable Object is serialized with a promise chain.
Each `execute`:

1. Ensure a live instance: reuse the in-memory one; else restore from the
   snapshot when its `build` matches the current engine; else boot fresh.
2. Reset the fuel budget and output counters. Fuel exhaustion in JavaScript
   raises the engine interrupt (instance survives); in Python and Perl it
   traps and the instance is discarded.
3. Run the language wrapper with `envVars` and `cwd`.
4. On success: diff `/workspace` against the loaded copy by content hash,
   diff linear memory against the previous per-page hashes, and write `meta`,
   changed files, and changed pages in one transaction. All-zero pages are
   deleted rather than stored.
5. On failure: keep the instance only for JavaScript interrupts and ordinary
   guest exceptions; drop it after traps and memory exhaustion. Workspace
   changes made by a failed execution are discarded by reloading the tree.

Snapshot rules, verified on the actual engines:

- Taken only between top-level calls (the shadow stack pointer is then at its
  initial value; Python and Perl have one mutable global, JavaScript two).
- Never taken after a trap.
- Not taken while the guest holds open file descriptors beyond the preopens;
  the execution still succeeds, but the session is marked as needing a
  rebuild, and the next request boots fresh and replays nothing (globals from
  that execution are lost; the response says so in `session.snapshot`).
- `restore` instantiates, sets `wasi.inst` directly (no `_initialize`, no
  `wasm_init`), grows memory to the snapshot page count, copies pages, and
  reuses the stored interpreter handle and interrupt addresses.
- Memory never shrinks; `POST /sessions/:id/reset` is the way to compact.

Snapshot size. JavaScript's image starts at about 33 MiB because the engine
carries 18 MiB of static data and an 8 MiB stack; Python starts at 13 MiB and
Perl at 10 MiB. Pages are deflated individually, and only changed pages are
rewritten. Local workerd measurements: writing 256 pages takes about 36 ms and
1024 pages about 156 ms; reading them back takes 5 ms and 19 ms. Diffing
against a canonical boot image would shrink JavaScript snapshots to roughly
7 MiB plus user data and is a follow-up.

Memory budget: the memory cap is 1024 pages (64 MiB) for all three snapshot
languages. Live instances stay in memory until the Durable Object hibernates.

## Limits

| Item | Limit |
| --- | --- |
| Session id | 128 characters |
| Workspace | 1 MiB per file, 16 MiB total, 4096 entries |
| Snapshot | 64 MiB linear memory, stored as at most 1024 deflated pages |
| Fuel per execution | Same as the stateless runtime |

## Deployment

The JavaScript, Python, and Perl packages export `SandboxSession`. Templates,
the CLI initializer, and `engine/wrangler-*.jsonc` gain:

```jsonc
"durable_objects": { "bindings": [{ "name": "SESSIONS", "class_name": "SandboxSession" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["SandboxSession"] }]
```

and the entrypoint becomes
`export { default, SandboxSession } from "@sandbox-workers/<language>";`.

## Phases

1. `runtime/workspace.mjs`; the session Durable Object with `/workspace`,
   `cwd`, the files API, and REPL execution kept alive in memory (no snapshot
   yet); JavaScript `fs`/`process` host functions and the module loader;
   typed client; gateway forwarding; wrangler, template, and CLI wiring;
   tests under `wrangler dev`.
2. Memory snapshots for JavaScript, Python, Perl: page hashing, deflate,
   transactional writes, restore, `reset`, the build guard, and the
   top-level-await hoisting transform for JavaScript.
3. Playground session mode, docs, and examples.
