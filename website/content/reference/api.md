---
title: API reference
description: The language-neutral JSON execution contract.
---

## POST /execute

Use `Content-Type: application/json`. A runtime Worker (the one behind your Service Binding) always executes a single language, so the request body carries no language field:

| Field      | Type                     | Required | Meaning                                                |
| ---------- | ------------------------ | -------- | ------------------------------------------------------- |
| `code`     | string                   | Yes      | Nonempty script; maximum 64 KiB UTF-8                   |
| `envVars`  | object of string values  | No       | Environment variables exposed to the script             |

The complete request is limited to 96 KiB. `envVars` keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, and every value must be a string; `null`/`undefined` values are skipped. A request that still contains an `input` or `language` key is rejected — pass data with `envVars`, and let the Service Binding (or, on the Playground gateway, the URL path) choose the runtime.

```json
{
  "code": "const x = Number(process.env.X);\nx ** 2",
  "envVars": { "X": "12" }
}
```

Only the Playground gateway fronts more than one runtime, and it picks one from the URL path: `POST /execute/<language>`, where `<language>` is `javascript`, `python`, `perl`, or `ruby`. `POST /execute` on the gateway is an alias for `/execute/javascript`.

Code is a **script**: the value of the last top-level expression is the result. There is no persistent context between calls — every call boots a fresh Wasm instance.

## Responses

Every execution — success, a guest error, or a fuel/output/result limit — returns HTTP 200 with an `ExecutionResult`:

```json
{
  "code": "const x = Number(process.env.X);\nx ** 2",
  "language": "javascript",
  "engine": "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6",
  "durationMs": 8,
  "logs": { "stdout": [], "stderr": [] },
  "results": [{ "text": "144" }],
  "usage": {
    "fuelConsumed": 1800000,
    "fuelLimit": 50000000,
    "memoryBytes": 34668544
  }
}
```

Metrics above are illustrative. `durationMs` is elapsed engine execution time; it is not a billing measurement. Fuel includes engine initialization and library loading. `usage` is absent when the engine failed before metering was available.

A guest error looks like this instead — `logs` produced before the error are still returned, and `results` is empty:

```json
{
  "code": "1 / 0",
  "language": "python",
  "engine": "CPython 3.14.6",
  "durationMs": 5,
  "logs": { "stdout": [], "stderr": [] },
  "results": [],
  "error": {
    "name": "ZeroDivisionError",
    "message": "division by zero",
    "traceback": ["Traceback (most recent call last):", "..."]
  }
}
```

### Result mapping

`results` has at most one entry, chosen from the value of the last top-level expression:

| Value                                              | Entry                                        |
| --------------------------------------------------- | --------------------------------------------- |
| JS `undefined`, Python `None`, Ruby `nil`, Perl `undef` | none — `results` is `[]`                  |
| Container (JS object/array, Python dict/list, Ruby Hash/Array, Perl HASH/ARRAY ref) | `{ "json": ... }`      |
| Anything else                                       | `{ "text": "..." }`, the language's native string representation |

The native `text` representation matches the language's own printing: JavaScript uses a `util.inspect`-like form (strings single-quoted, e.g. `'hi'`; BigInt as `123n`), Python uses `repr(v)`, Ruby uses `v.inspect`, and Perl uses `"$v"` string interpolation. If a container fails to serialize as JSON, it falls back to a `text` entry using the same native representation.

### Env vars per language

| Language   | Access                |
| ---------- | ---------------------- |
| JavaScript | `process.env.NAME`     |
| Python     | `os.environ["NAME"]`   |
| Perl       | `$ENV{NAME}`            |
| Ruby       | `ENV["NAME"]`           |

Only the key/value pairs passed in `envVars` are visible; nothing from the host environment leaks through.

### Status codes

| Status | Meaning                                                                             |
| ------ | ------------------------------------------------------------------------------------ |
| 200    | Every execution: success, a guest error, or a fuel/output/result limit — check `error` |
| 400    | Invalid JSON, an unsupported `/execute/<language>` gateway path, invalid `envVars`, or an `input`/`language` key in the body (`VALIDATION_FAILED`) |
| 405    | Wrong HTTP method (`VALIDATION_FAILED`)                                              |
| 413    | Request or code too large (`VALIDATION_FAILED`)                                      |
| 415    | Unsupported Content-Type (`VALIDATION_FAILED`)                                       |
| 502    | Gateway could not call a Service Binding (`INTERNAL_ERROR`)                          |

Only request/transport failures (400, 405, 413, 415, 502) use a non-200 status, with the body shaped as an `ErrorResponse` — `{ "code": "VALIDATION_FAILED", "message": "...", "context": {}, "httpStatus": 400, "timestamp": "..." }` (see [Sandboxes](#sandboxes) for the full `code` list). There is no `ok` field and no 422 status — fuel exhaustion and output/result limits are reported as a 200 response with `error.name` set to `"ExecutionLimitError"`.

Always check the `error` field, not the HTTP status, to see whether guest code succeeded.

## Sandboxes

A **sandbox** is a Durable Object, keyed by a caller-chosen id, that owns a shared `/workspace` and one or more named **code contexts** — durable REPLs. See the [sandboxes and code contexts guide](/guides/sessions) for the full contract, the files API, and per-language semantics. Code contexts are supported for JavaScript, Python, and Perl; on a Ruby runtime Worker every `/sandboxes/:id/*` route answers 400 `Code contexts are not supported for ruby`, except a context-less `execute`, which runs statelessly. Sandbox ids match `^[A-Za-z0-9._-]{1,128}$`.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sandboxes/:id/execute` | `{code, contextId?, language?, envVars?}` | The `/execute` result plus `context: {id, cwd, executions, snapshotMs?, expiresAt?}`; always 200 for guest errors |
| `POST /sandboxes/:id/contexts` | `{language?, cwd?, envVars?}` | `{id, language, cwd, createdAt, lastUsed}` (201) |
| `GET /sandboxes/:id/contexts` | | `{contexts: [{id, language, cwd, createdAt, lastUsed}]}` |
| `DELETE /sandboxes/:id/contexts/:contextId` | | `{success: true}`; 404 `CONTEXT_NOT_FOUND` |
| `POST /sandboxes/:id/env` | `{envVars: Record<string, string \| null>}` (`null` unsets a key) | `{success: true}` |
| `POST /sandboxes/:id/files` | `{op, path, newPath?, content?, encoding?, recursive?, force?, includeHidden?}` | Per operation — see the guide |
| `GET /sandboxes/:id` | | `SandboxInfo`: `{id, language, engine, createdAt, lastUsed, envVars, contexts, workspace: {files, bytes}, expiresAt}` |
| `DELETE /sandboxes/:id` | | `{success: true}` — wipes storage and drops every context |

Each entry of `contexts` (in `GET /sandboxes/:id`) is `{id, language, cwd, createdAt, lastUsed, executions, snapshot}`. `snapshot` is `{build, pages, bytes, takenAt, stale}` once that context has taken at least one memory snapshot (surviving Durable Object eviction, hibernation, and redeploys — see the guide's "Memory snapshots" section for when a snapshot is skipped, `stale`, and how deleting a context compacts it), or `null` before its first one. `context.snapshotMs` on the execute response is present only on an execution that actually wrote a snapshot. `expiresAt` is the epoch-millisecond deadline of the sandbox's idle-expiry Durable Object alarm — every request that touches the sandbox (re)arms it, and it deletes the whole sandbox (all contexts and files) when it fires unused, the same as `DELETE`; it is `null` when the runtime Worker's `SESSION_IDLE_TTL_MS` env var disables expiry (`"0"`), and the execute response's `context.expiresAt` is then omitted instead. See the guide's "Idle expiry" section.

### Files API

`op` is `read`, `write`, `mkdir`, `delete`, `rename`, `move`, `list`, or `exists`. `rename` and `move` are the same operation; `move` additionally requires the destination's parent directory to exist.

| `op` | Extra fields | Response |
| --- | --- | --- |
| `read` | `encoding?` | `{success, path, content, encoding, isBinary, mimeType, size, timestamp}` |
| `write` | `content`, `encoding?` | `{success, path, timestamp}` |
| `mkdir` | `recursive?` | `{success, path, recursive, timestamp}` |
| `delete` | `recursive?`, `force?` | `{success, path, timestamp}` — a directory needs `recursive: true`; `force: true` ignores a missing path |
| `rename` / `move` | `newPath` | `{success, path, newPath, timestamp}` |
| `list` | `recursive?`, `includeHidden?` | `{success, path, files: FileInfo[], count, timestamp}` |
| `exists` | | `{success, path, exists, timestamp}` |

### Errors

Every non-200 response on `/sandboxes/*` (and, since this change, on `/execute`) is an `ErrorResponse`: `{code, message, context, httpStatus, timestamp, operation?}`.

| `code` | HTTP status | Meaning |
| --- | --- | --- |
| `FILE_NOT_FOUND` | 404 | Path does not exist |
| `FILE_EXISTS` | 409 | Path already exists (`rename`/`move` destination, non-`force` conflicts) |
| `PERMISSION_DENIED` | 403 | Path escapes `/workspace`, or the underlying `EACCES` |
| `IS_DIRECTORY` | 400 | Expected a file, found a directory |
| `NOT_DIRECTORY` | 400 | Expected a directory, found a file |
| `FILE_TOO_LARGE` | 413 | Exceeds the 1 MiB per-file or 16 MiB per-workspace limit |
| `NO_SPACE` | 507 | Workspace entry-count limit (4096) reached |
| `FILESYSTEM_ERROR` | 400 | `ENOTEMPTY` or any other filesystem error |
| `CONTEXT_NOT_FOUND` | 404 | Unknown `contextId` |
| `VALIDATION_FAILED` | 400 | Malformed request (also used with 413/415/405 for request-shape failures) |
| `CODE_EXECUTION_ERROR` | 500 | The engine failed before producing a result |
| `INTERNAL_ERROR` | 500 | Anything else, or a non-JSON response |

File-operation errors carry `context.errno`, the Node-style code (`ENOENT`, `EEXIST`, `EACCES`, `EISDIR`, `ENOTDIR`, `EFBIG`, `ENOSPC`, `ENOTEMPTY`, …) alongside the mapped `code` above.

### Gateway path

The Playground gateway forwards `/languages/:language/sandboxes/:id` and any further sub-path (for example `/languages/:language/sandboxes/:id/execute` or `/languages/:language/sandboxes/:id/files`) to the matching runtime binding's `/sandboxes/:id[/...]`, for `GET`, `POST`, and `DELETE`, preserving the body and status code. An unsupported `:language` returns 400, the same as `/execute`.

## GET /languages

The Playground gateway returns `{languages:[...]}` with runtime IDs, names, package versions, engine names, execution modes, capabilities, and configured limits. Individual engine Workers expose only `/execute`.

## Raw Service Binding calls

The request URL may use any placeholder hostname; the binding determines the destination Worker. The path must be `/execute`. This API provides no host-network capability to the submitted code.
