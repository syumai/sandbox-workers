---
title: HTTP API
description: The raw JSON contract behind the typed client, for callers that talk to a runtime Worker directly.
---

`@sandbox-workers/core`'s typed client (see [Lifecycle](/api/lifecycle), [Code interpreter](/api/interpreter), and [Files](/api/files)) is a thin wrapper over this HTTP contract. Use this page if you're calling a runtime Worker's Service Binding directly instead.

## `POST /execute`

Stateless execution: a runtime Worker (the one behind your Service Binding) always executes a single language, so the request body carries no language field. Use `Content-Type: application/json`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `code` | string | Yes | Nonempty script; maximum 64 KiB UTF-8 |
| `envVars` | object of string values | No | Environment variables exposed to the script |

The complete request is limited to 96 KiB. `envVars` keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, and every value must be a string; `null`/`undefined` values are skipped. A request that still contains an `input` or `language` key is rejected — pass data with `envVars`, and let the Service Binding (or, on the Playground gateway, the URL path) choose the runtime.

```json
{
  "code": "const x = Number(process.env.X);\nx ** 2",
  "envVars": { "X": "12" }
}
```

Code is a **script**: the value of the last top-level expression is the result. There is no persistent context between calls — every call boots a fresh Wasm instance. For a durable, stateful alternative, see [Sandboxes](#sandboxes) below.

### Responses

Every execution — success, a guest error, or a fuel/output/result limit — returns HTTP 200 with an `ExecutionResult` (see [Code interpreter](/api/interpreter#types) for the full shape and the result-mapping rules):

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

### Status codes

| Status | Meaning |
| --- | --- |
| 200 | Every execution: success, a guest error, or a fuel/output/result limit — check `error` |
| 400 | Invalid JSON, an unsupported `/execute/<language>` gateway path, invalid `envVars`, or an `input`/`language` key in the body (`VALIDATION_FAILED`) |
| 405 | Wrong HTTP method (`VALIDATION_FAILED`) |
| 413 | Request or code too large (`VALIDATION_FAILED`) |
| 415 | Unsupported Content-Type (`VALIDATION_FAILED`) |
| 502 | Gateway could not call a Service Binding (`INTERNAL_ERROR`) |

Only request/transport failures (400, 405, 413, 415, 502) use a non-200 status, with the body shaped as an `ErrorResponse` (see [Errors](/api/errors)) — `{ "code": "VALIDATION_FAILED", "message": "...", "context": {}, "httpStatus": 400, "timestamp": "..." }`. There is no `ok` field and no 422 status — fuel exhaustion and output/result limits are reported as a 200 response with `error.name` set to `"ExecutionLimitError"`.

Always check the `error` field, not the HTTP status, to see whether guest code succeeded.

## Sandboxes

A **sandbox** is a Durable Object, keyed by a caller-chosen id, that owns a shared `/workspace` and one or more named code contexts. See [Sandboxes](/concepts/sandboxes) and [Code contexts](/concepts/code-contexts) for the full behavior. Code contexts are supported for JavaScript, Python, and Perl; on a Ruby runtime Worker every `/sandboxes/:id/*` route answers 400 `Code contexts are not supported for ruby`, except a context-less `execute`, which runs statelessly. Sandbox ids match `^[A-Za-z0-9._-]{1,128}$`.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sandboxes/:id/execute` | `{code, contextId?, language?, envVars?}` | The `/execute` result plus `context: {id, cwd, executions, snapshotMs?, expiresAt?}`; always 200 for guest errors |
| `POST /sandboxes/:id/contexts` | `{language?, cwd?, envVars?}` | `{id, language, cwd, createdAt, lastUsed}` (201) |
| `GET /sandboxes/:id/contexts` | | `{contexts: [{id, language, cwd, createdAt, lastUsed}]}` |
| `DELETE /sandboxes/:id/contexts/:contextId` | | `{success: true}`; 404 `CONTEXT_NOT_FOUND` |
| `POST /sandboxes/:id/env` | `{envVars: Record<string, string \| null>}` (`null` unsets a key) | `{success: true}` |
| `POST /sandboxes/:id/files` | `{op, path, newPath?, content?, encoding?, recursive?, force?, includeHidden?}` | Per operation — see the files table below |
| `GET /sandboxes/:id` | | `SandboxInfo` — see [Types](#types) below |
| `DELETE /sandboxes/:id` | | `{success: true}` — wipes storage and drops every context |

### Files API

`op` is `read`, `write`, `mkdir`, `delete`, `rename`, `move`, `list`, or `exists`. `path` (and `newPath` for `rename`/`move`) is absolute under `/workspace`; it is normalized and rejected if it would escape `/workspace`. `encoding` is `utf-8` (default) or `base64`, for `read` and `write`. `rename` and `move` are the same operation; `move` additionally requires the destination's parent directory to exist.

| `op` | Extra fields | Response |
| --- | --- | --- |
| `read` | `encoding?` | `{success, path, content, encoding, isBinary, mimeType, size, timestamp}` |
| `write` | `content`, `encoding?` | `{success, path, timestamp}` |
| `mkdir` | `recursive?` | `{success, path, recursive, timestamp}` |
| `delete` | `recursive?`, `force?` | `{success, path, timestamp}` — a directory needs `recursive: true`; `force: true` ignores a missing path |
| `rename` / `move` | `newPath` | `{success, path, newPath, timestamp}` |
| `list` | `recursive?`, `includeHidden?` | `{success, path, files: FileInfo[], count, timestamp}` |
| `exists` | | `{success, path, exists, timestamp}` |

A `FileInfo` entry is `{name, absolutePath, relativePath, type, size, modifiedAt, mode, permissions}`; hidden entries (name starting with `.`) are omitted unless `includeHidden` is set. See [Files](/api/files) for the typed-client equivalents and their per-method result shapes.

### Errors

Every non-200 response on `/sandboxes/*` (and on `/execute`) is an `ErrorResponse`: `{code, message, context, httpStatus, timestamp, operation?}`. See [Errors](/api/errors) for the full `code` → HTTP status table and what each `context` carries. File-operation errors carry `context.errno`, the Node-style code (`ENOENT`, `EEXIST`, `EACCES`, `EISDIR`, `ENOTDIR`, `EFBIG`, `ENOSPC`, `ENOTEMPTY`, ...) alongside the mapped `code`.

## Types

`SandboxInfo`, the `GET /sandboxes/:id` response:

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
    snapshot: { build: string; pages: number; bytes: number; storedBytes: number; takenAt: string; stale: boolean } | null;
  }>;
  workspace: { files: number; bytes: number };
  expiresAt: number | null;
}
```

`snapshot` is `null` before a context's first memory snapshot. `storedBytes` is the actual on-disk footprint of the snapshot — always a multiple of 1 MiB and at least `bytes`, since snapshots are stored in 1 MiB chunks. `expiresAt` is the epoch-millisecond deadline of the sandbox's idle-expiry alarm, or `null` when expiry is disabled; the execute response's `context.expiresAt` is then omitted instead. See [Sandboxes](/concepts/sandboxes) and [Environment variables](/configuration/environment-variables).

## Gateway paths

Only the Playground gateway fronts more than one runtime Worker; it picks one from the URL path. Individual runtime Workers behind a Service Binding expose `/execute` and `/sandboxes/:id/*` (on Ruby, only a context-less `/sandboxes/:id/execute` succeeds; every other `/sandboxes/:id/*` route answers 400).

- `POST /execute/<language>`, where `<language>` is `javascript`, `python`, `perl`, or `ruby`. `POST /execute` on the gateway is an alias for `/execute/javascript`. An unsupported `<language>` returns 400.
- `/languages/:language/sandboxes/:id` and any further sub-path (for example `/languages/:language/sandboxes/:id/execute` or `/languages/:language/sandboxes/:id/files`) forward, for `GET`, `POST`, and `DELETE`, to the matching runtime binding's `/sandboxes/:id[/...]`, preserving the body and status code. An unsupported `:language` returns 400, the same as `/execute`.

### `GET /languages`

The Playground gateway returns `{languages:[...]}` with runtime IDs, names, package versions, engine names, execution modes, capabilities, and configured limits. Individual runtime Workers do not expose this route.

## Raw Service Binding calls

The request URL may use any placeholder hostname — the binding determines the destination Worker. The path must be `/execute` or `/sandboxes/...`. This API provides no host-network capability to the submitted code.
