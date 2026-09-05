# Durable sandbox sessions: design

Status: design accepted 2026-09-05, implementation in progress. This document is the
specification for the session layer that keeps sandbox state in Durable Objects.
It follows the same split as Cloudflare's Sandbox SDK: a session is a Durable
Object that owns durable state, while the interpreter instance held in memory is
a best-effort cache that can disappear at any time.

## Goals

- A caller can run code repeatedly in one named session and observe state that
  survives Durable Object eviction, hibernation, and redeploys.
- The durable contract is the same for JavaScript, Python, Perl, and Ruby:
  a JSON `state` value, a writable `/workspace` directory, and a `cwd`.
- For JavaScript, Python, and Perl the whole interpreter heap is additionally
  persisted as a linear-memory snapshot, so functions, classes, imported modules,
  and live objects survive as well. Ruby is excluded (its initial memory is
  35.6 MiB and it keeps host-side state in `RubyVM`).
- The stateless `POST /execute` keeps its fresh-instance-per-request guarantee.
- Callers keep using a Service Binding to the runtime Worker. No direct Durable
  Object binding is required in the calling application.

## Non-goals (for now)

- Streaming output, file watching, Git, R2 mounts, background processes.
- Sharing a workspace between sessions.
- Sessions for the public Playground gateway beyond a demo mode (phase 3).

## Trust model

A session is one trust domain (one user or one agent). Executions in the same
session may observe and interfere with each other by design; the host boundary
(the WASI allowlist, fuel, the memory cap) is unchanged. Sessions never share a
Wasm instance, and nothing session-specific may live in module scope, because
Durable Objects of one class can share an isolate. Session ids are chosen by the
caller and must already be tenant-scoped; the runtime does not authenticate.

## HTTP API of a runtime Worker

All routes are under `/sessions/:id` where `id` matches `^[A-Za-z0-9._-]{1,128}$`.
Bodies and responses are JSON. Errors use the existing `errorResponse` shape.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sessions/:id/execute` | `{code, input?, cwd?}` | Execution response as `/execute`, plus `session: {id, cwd, executions}` |
| `GET /sessions/:id` | | `{id, language, engine, cwd, createdAt, lastUsed, executions, workspace: {files, bytes}, snapshot: {pages, bytes} \| null}` |
| `DELETE /sessions/:id` | | `{ok: true}`; deletes storage and drops the instance |
| `POST /sessions/:id/reset` | | Drops the snapshot and the live instance, keeps `state`, files, and `cwd` |
| `GET /sessions/:id/state` | | `{state}` |
| `PUT /sessions/:id/state` | `{state}` | `{state}` |
| `DELETE /sessions/:id/state` | | `{state: {}}` |
| `POST /sessions/:id/files` | `{op: "read" \| "write" \| "list" \| "delete" \| "rename" \| "mkdir" \| "exists" \| "stat", path, newPath?, content?, encoding?, recursive?}` | Per op; see below |

File operations. `path` is absolute under `/workspace`, or relative to the
session `cwd`; it is normalized first and rejected if it escapes `/workspace`.
`encoding` is `utf-8` (default) or `base64`. `read` returns
`{content, size, encoding, isBinary, updatedAt}`; `list` returns
`{entries: [{path, type, size, updatedAt}]}` and accepts `recursive`; `write`
returns `{size}`; `exists` returns `{exists}`; `stat` returns
`{type, size, updatedAt}`. Limits: 1 MiB per file, 16 MiB per workspace,
4096 entries.

The gateway (`src/index.ts`) forwards `/languages/:language/sessions/:id/...` to
the runtime binding for `:language` as `/sessions/:id/...`.

## Typed client (`@sandbox-workers/core`)

```ts
const sandbox = createSandbox(env.SANDBOX, "python");
await sandbox.execute({ code, input });            // unchanged, stateless

const session = sandbox.session("user-42");
await session.execute({ code, input, cwd? });
await session.info();
await session.reset();
await session.destroy();
await session.getState(); await session.setState(value); await session.clearState();
await session.readFile(path, { encoding? });
await session.writeFile(path, content, { encoding? });   // string or Uint8Array
await session.listFiles(path, { recursive? });
await session.deleteFile(path); await session.renameFile(from, to);
await session.mkdir(path); await session.exists(path);
```

Method names follow the Sandbox SDK so that code written against it ports with
few changes.

## Guest contract

Code stays a function body. In addition to `input`, the guest receives `state`:

| Language | `state` | cwd |
| --- | --- | --- |
| JavaScript | second parameter of the async function body | no effect (no filesystem) |
| Python | `state` dict, second parameter of `__sandbox_main` | `os.chdir(cwd)` before the body |
| Perl | `$state` hash reference | `chdir($cwd)` before the body |
| Ruby | `state` Hash with string keys | `Dir.chdir(cwd)` before the body |

Only in-place mutation of `state` is persisted; rebinding the name has no
effect. After the body returns, the wrapper serializes `state` to JSON and
reports the current working directory (`os.getcwd()`, `Cwd::getcwd()`,
`Dir.pwd`). A `state` that is not JSON-serializable or larger than 1 MiB makes
the execution fail with `ok: false`, and nothing from that execution is
persisted. The persisted `cwd` must be an existing directory under
`/workspace`; anything else resets to `/workspace`.

Durable writes happen only after a successful execution: `state`, changed
workspace files, `cwd`, and (where supported) the memory snapshot are written
in one Durable Object transaction. Failed executions, fuel exhaustion, and
memory exhaustion discard every in-memory change and, for snapshot languages,
the live instance.

## Durable Object

`SandboxSession` is exported by every runtime package next to the default
Worker and is generic over the language runtime through a small `Engine`
interface:

```ts
interface Engine {
  language: string;
  engine: string;                     // human-readable engine string
  build: string;                      // sha256 of dist/engine.wasm, from build time
  snapshot: boolean;                  // JavaScript, Python, Perl: true; Ruby: false
  boot(host: Host): Promise<Instance>;             // fresh interpreter
  restore(host: Host, snapshot: Snapshot): Instance; // memory copy, no re-init
  execute(instance, payload): Promise<Result>;      // runs the wrapper for this language
}
```

`Host` is created by `createWasi` with an extra preopen: the read-only
`/stdlib` (Python, Perl), `/dev`, and the writable `/workspace` whose `Map` is
loaded from storage. The preopen order is fixed and part of the snapshot
contract because wasi-libc records preopen fd numbers in linear memory.

Storage (SQLite-backed Durable Object; `new_sqlite_classes` migration):

| Key or table | Content |
| --- | --- |
| `meta` | `{id, language, build, cwd, createdAt, lastUsed, executions, lifetime}` |
| `state` | JSON value, at most 1 MiB |
| `files` table | `path TEXT PRIMARY KEY, data BLOB, updated_at INTEGER` |
| `pages` table | `page INTEGER PRIMARY KEY, data BLOB` (64 KiB pages, deflated with fflate) |
| `snapshot` | `{build, pages, bytes, handle, extra}` where `extra` holds engine-specific integers such as interrupt addresses |

`lifetime` is rotated on `DELETE` so that in-flight work started before a
destroy cannot write into the new session (same idea as the Sandbox SDK's
lifetime id).

Request handling inside the Durable Object is serialized with a promise chain
(Ruby boot is asynchronous). Each `execute`:

1. Ensure a live instance: reuse the in-memory one; else restore from the
   snapshot when its `build` matches the current engine; else boot fresh.
2. Reset the fuel budget and output counters. Fuel exhaustion in JavaScript
   raises the engine interrupt (instance survives); in Python and Perl it traps
   and the instance is discarded.
3. Run the language wrapper with `input`, `state`, `cwd`.
4. On success: diff `/workspace` against the loaded copy by content hash,
   diff linear memory against the previous page hashes, and write `meta`,
   `state`, changed files, and changed pages in one transaction. Pages that
   are entirely zero are deleted rather than stored.
5. On failure: discard the workspace `Map` and reload it lazily; for snapshot
   languages also drop the instance.

Snapshot rules, verified on the actual engines:

- Taken only between top-level calls (the shadow stack pointer is then at its
  initial value; Python and Perl have one mutable global, JavaScript two).
- Never taken after a trap.
- Not taken while the guest holds open file descriptors beyond the preopens;
  the execution still succeeds, but the instance is marked non-snapshottable
  and will be rebuilt from `state` and files next time.
- `restore` instantiates, sets `wasi.inst` directly (no `_initialize`, no
  `wasm_init`), grows memory to the snapshot page count, copies pages, and
  reuses the stored interpreter handle. Python re-seeds `random` and
  JavaScript re-seeds `Math.random` in the wrapper after a restore.
- Memory never shrinks; `POST /sessions/:id/reset` is the way to compact.

Memory budget: the memory cap is 1024 pages (64 MiB) for all three snapshot
languages. Live instances stay in memory until the Durable Object hibernates.

## Limits

| Item | Limit |
| --- | --- |
| Session id | 128 characters |
| `state` | 1 MiB serialized |
| Workspace | 1 MiB per file, 16 MiB total, 4096 entries |
| Snapshot | 64 MiB linear memory, stored as ≤1024 deflated pages |
| Fuel per execution | Same as the stateless runtime |

## Deployment

Each runtime package exports `SandboxSession`. Templates, the CLI initializer,
and `engine/wrangler-*.jsonc` gain:

```jsonc
"durable_objects": { "bindings": [{ "name": "SESSIONS", "class_name": "SandboxSession" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["SandboxSession"] }]
```

and the entrypoint becomes `export { default, SandboxSession } from "@sandbox-workers/<language>";`.

## Phases

1. Session Durable Object with `state`, `/workspace`, `cwd`, files API, typed
   client, gateway forwarding, wrangler/template/CLI wiring, tests under
   `wrangler dev`.
2. Memory snapshots for JavaScript, Python, Perl, including page diffing,
   restore, `reset`, and a build-hash guard.
3. Playground: session mode in the UI, docs, and examples.
