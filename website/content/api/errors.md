---
title: Errors
description: The SandboxError hierarchy, the ErrorResponse shape, and the error code table.
---

**Mode:** both.

`@sandbox-workers/core` distinguishes two kinds of failure:

- **Guest errors** — the executed code raised an exception, or hit a fuel/output/result limit. These never throw: `runCode()` still resolves, with the failure described in `result.error` (see [Code interpreter](/api/interpreter#types)).
- **Transport and request errors** — a binding failure, a malformed response, or a non-200 response from the runtime Worker (an invalid path, a missing file, a bad request body, and so on). These are thrown as a `SandboxError` subclass.

This page covers the second kind.

## The `SandboxError` hierarchy

Every thrown error is `SandboxError` or one of its subclasses, all exported by `@sandbox-workers/core`:

| Class | `code` | Extra `context` fields |
| --- | --- | --- |
| `SandboxError` | any (base class; also thrown directly for a non-JSON or otherwise malformed error body, with `code: "INTERNAL_ERROR"`) | — |
| `FileNotFoundError` | `FILE_NOT_FOUND` | `path`, `operation` |
| `FileExistsError` | `FILE_EXISTS` | `path`, `operation` |
| `FileTooLargeError` | `FILE_TOO_LARGE` | `path`, `operation`, `maxSize`, `actualSize` |
| `PermissionDeniedError` | `PERMISSION_DENIED` | `path`, `operation` |
| `FileSystemError` | `NO_SPACE`, `IS_DIRECTORY`, `NOT_DIRECTORY`, or `FILESYSTEM_ERROR` | `path`, `operation` |
| `ContextNotFoundError` | `CONTEXT_NOT_FOUND` | `contextId` |
| `ValidationFailedError` | `VALIDATION_FAILED` | `validationErrors?` (an array of `{ field, message }`) |
| `CodeExecutionError` | `CODE_EXECUTION_ERROR` | `contextId?`, `ename?`, `evalue?` |
| `NotSupportedError` | `NOT_SUPPORTED` | `feature` |

## Binding validation errors

`createCodeContext({ binding })` (and default-context resolution for `runCode({ binding })`) probes the named binding before creating anything, and throws `ValidationFailedError` with one of these messages when it fails:

| Message | Cause |
| --- | --- |
| `Unknown binding 'X'` | No such key in your Worker's `env`, or the name doesn't match `/^[A-Za-z_][A-Za-z0-9_]*$/` |
| `Binding 'X' is not a sandbox-workers runtime Worker` | The binding exists but has no `fetch` method, or `GET /interpreter` on it didn't return `{ language, engine, contexts }` |
| `Code contexts are not supported by binding 'X' (language)` | The binding is a real runtime Worker, but it reports `contexts: false` (a stateless-only runtime Worker: Ruby, or one deployed with `--stateless`) |
| `Pass a context or a binding` | `runCode()` was called with neither `context` nor `binding` |

This probe runs only on `createCodeContext` and default-context creation, never on every execution.

Every instance also carries `error.code`, `error.context`, `error.httpStatus`, `error.timestamp`, and `error.operation` (getters backed by `error.errorResponse`, the raw `ErrorResponse`).

For filesystem failures specifically, `error.context.errno` carries the Node-style error code (`ENOENT`, `EEXIST`, `EACCES`, `EISDIR`, `ENOTDIR`, `EFBIG`, `ENOSPC`, `ENOTEMPTY`, ...) alongside the mapped `code` in the table above.

```ts
import { FileNotFoundError } from "@sandbox-workers/core";

try {
  await sandbox.readFile("/workspace/missing.txt");
} catch (error) {
  if (error instanceof FileNotFoundError) {
    console.error(error.code, error.httpStatus, error.context.path);
    // "FILE_NOT_FOUND", 404, "/workspace/missing.txt"
  } else {
    throw error;
  }
}
```

## `ErrorResponse`

The JSON shape every non-200 HTTP response carries, and the shape wrapped by every `SandboxError`:

```ts
interface ErrorResponse {
  code: string;
  message: string;
  context: Record<string, unknown>;
  httpStatus: number;
  timestamp: string;
  operation?: OperationType;
  suggestion?: string;     // typed for SDK parity; not currently emitted
  documentation?: string;  // typed for SDK parity; not currently emitted
}
```

`operation`, when present, is one of the dotted strings in the exported `Operation` object (`Operation.FILE_READ` = `"file.read"`, `Operation.FILE_WRITE` = `"file.write"`, `Operation.FILE_DELETE` = `"file.delete"`, `Operation.FILE_MOVE` = `"file.move"`, `Operation.FILE_RENAME` = `"file.rename"`, `Operation.FILE_STAT` = `"file.stat"`, `Operation.DIRECTORY_CREATE` = `"directory.create"`, `Operation.DIRECTORY_LIST` = `"directory.list"`, `Operation.CODE_EXECUTE` = `"code.execute"`, `Operation.CODE_CONTEXT_CREATE` = `"code.context.create"`, `Operation.CODE_CONTEXT_DELETE` = `"code.context.delete"`), typed as `OperationType`.

## Error code table

| `code` | HTTP status | Meaning |
| --- | --- | --- |
| `FILE_NOT_FOUND` | 404 | Path does not exist |
| `FILE_EXISTS` | 409 | Path already exists (`rename`/`move` destination, non-`force` conflicts) |
| `PERMISSION_DENIED` | 403 | Path escapes `/workspace`, or the underlying `EACCES` |
| `IS_DIRECTORY` | 400 | Expected a file, found a directory; also `deleteFile()` on any directory without `recursive: true` |
| `NOT_DIRECTORY` | 400 | Expected a directory, found a file |
| `FILE_TOO_LARGE` | 413 | Exceeds the 1 MiB per-file or 16 MiB per-workspace limit |
| `NO_SPACE` | 500 | Workspace entry-count limit (4096) reached |
| `FILESYSTEM_ERROR` | 500 | `ENOTEMPTY`, any other filesystem error, or any failed `mkdir` (which always reports this code, regardless of the underlying errno) |
| `CONTEXT_NOT_FOUND` | 404 | Unknown `contextId` |
| `VALIDATION_FAILED` | 400 | Malformed request (also used with 413/415/405 for request-shape failures) |
| `CODE_EXECUTION_ERROR` | 500 | The engine failed before producing a result |
| `NOT_SUPPORTED` | 403 | The File API is disabled for this Worker (`SANDBOX_FILE_API=disabled`) |
| `INTERNAL_ERROR` | 500 | Anything else, or a non-JSON response |

See [HTTP API](/api/http-api) for the full set of routes and status codes these errors come from.
