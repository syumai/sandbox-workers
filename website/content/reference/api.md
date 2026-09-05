---
title: API reference
description: The language-neutral JSON execution contract.
---

## POST /execute

Use `Content-Type: application/json`.

| Field      | Type                     | Required | Meaning                                                |
| ---------- | ------------------------ | -------- | ------------------------------------------------------- |
| `language` | string                   | No       | `javascript`, `python`, `perl`, or `ruby`               |
| `code`     | string                   | Yes      | Nonempty script; maximum 64 KiB UTF-8                   |
| `envVars`  | object of string values  | No       | Environment variables exposed to the script             |

The gateway defaults to JavaScript. Individual engine Workers default to their own language. An explicitly mismatched language is rejected. The complete request is limited to 96 KiB. `envVars` keys must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, and every value must be a string; `null`/`undefined` values are skipped. A request that still contains an `input` key is rejected — pass data with `envVars` instead.

```json
{
  "language": "javascript",
  "code": "const x = Number(process.env.X);\nx ** 2",
  "envVars": { "X": "12" }
}
```

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
| 400    | Invalid JSON, unsupported language, invalid `envVars`, or an `input` key in the body  |
| 405    | Wrong HTTP method                                                                     |
| 413    | Request or code too large                                                            |
| 415    | Unsupported Content-Type                                                             |
| 502    | Gateway could not call a Service Binding                                            |

Only request/transport failures (400, 405, 413, 415, 502) use a non-200 status, with the body `{ "error": { "name": "ApiError", "message": "..." } }`. There is no `ok` field and no 422 status — fuel exhaustion and output/result limits are reported as a 200 response with `error.name` set to `"ExecutionLimitError"`.

Always check the `error` field, not the HTTP status, to see whether guest code succeeded.

## Sessions

A **session** is a named, durable REPL backed by a Durable Object — see the [sessions guide](/guides/sessions) for the full contract, the files API, and per-language semantics. Sessions are supported for JavaScript, Python, and Perl; every `/sessions/*` route on a Ruby runtime Worker returns 400 `Sessions are not supported for ruby`. Session ids match `^[A-Za-z0-9._-]{1,128}$`.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /sessions/:id/execute` | `{code, envVars?, cwd?}` | The `/execute` result plus `session: {id, cwd, executions, snapshotMs?}`; always 200 |
| `GET /sessions/:id` | | `{id, language, engine, cwd, createdAt, lastUsed, executions, workspace: {files, bytes}, snapshot}` |
| `DELETE /sessions/:id` | | `{ok: true}` |
| `POST /sessions/:id/reset` | | `{ok: true}` |
| `POST /sessions/:id/files` | `{op, path, newPath?, content?, encoding?, recursive?, force?}` | Per operation — see the sessions guide |

`snapshot` is `{build, pages, bytes, takenAt, stale}` once a session has taken at least one memory snapshot (surviving Durable Object eviction, hibernation, and redeploys — see the sessions guide's "Memory snapshots" section for when a snapshot is skipped, `stale`, and how `reset` compacts), or `null` before the first one / right after `reset`. `session.snapshotMs` on the execute response is present only on an execution that actually wrote a snapshot. File operation failures return a 4xx status with `{error: {name: "FileError", code, message}}`; other transport and validation errors on these routes use the same `{error: {name: "ApiError", message}}` shape as `/execute`.

### Gateway path

The Playground gateway forwards `/languages/:language/sessions/:id` and any further sub-path (for example `/languages/:language/sessions/:id/execute` or `/languages/:language/sessions/:id/files`) to the matching runtime binding's `/sessions/:id[/...]`, for `GET`, `POST`, and `DELETE`, preserving the body and status code. An unsupported `:language` returns 400, the same as `/execute`.

## GET /languages

The Playground gateway returns `{languages:[...]}` with runtime IDs, names, package versions, engine names, execution modes, capabilities, and configured limits. Individual engine Workers expose only `/execute`.

## Raw Service Binding calls

The request URL may use any placeholder hostname; the binding determines the destination Worker. The path must be `/execute`. This API provides no host-network capability to the submitted code.

## Differences from the Cloudflare Sandbox SDK

This protocol mirrors the shape of the Cloudflare Sandbox SDK's code interpreter (`runCode`, `ExecutionResult`, `logs`/`results`/`error`), with a few differences:

- **No persistent context.** Every call boots a fresh Wasm instance; there is no `createCodeContext`/`context` concept and no state carries over between calls.
- **No `exec`/files.** There is no shell execution or filesystem access from guest code.
- **`envVars` values must be strings.** Pass complex data as a JSON string and parse it in guest code if needed.
