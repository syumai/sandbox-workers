# @sandbox-workers/core

Typed client and shared execution protocol for `@sandbox-workers/*` runtime
Workers. This package contains **no Wasm engine**. Deploy a runtime Worker
separately and add a binding:

```jsonc
// Caller wrangler.jsonc (merge into your existing configuration)
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }] }
```

```ts
import { getSandbox } from "@sandbox-workers/core";

export default {
  async fetch(request, env) {
    const sandbox = getSandbox(env.SANDBOX, "user-42");
    const result = await sandbox.runCode(
      "const x = Number(process.env.X);\nx ** 2",
      { envVars: { X: "12" } },
    );
    return Response.json(result);
  },
};
```

`runCode(code, options?)` resolves to an `ExecutionResult`. Code is a
script — the value of the last expression is the result. Guest failures and
resource limits (fuel, output, result size) set `result.error` instead of
throwing; binding/network failures and non-200 responses throw a
`SandboxError` subclass (see [Errors](#errors)). `getSandbox(target, id,
options?)` validates `id` against `/^[A-Za-z0-9._-]{1,128}$/` (optionally
lowercasing it first with `{ normalizeId: true }`) and returns a client for
one sandbox — a Durable Object inside the runtime Worker, keyed by `id`. It
works with JavaScript, Python, Perl, Ruby, and additional runtime Workers
implementing the same protocol. The client calls only the supplied binding;
it never sends code to the public Playground.

## Transports

`target` is either:

- a **Service Binding** to the runtime Worker (`Fetcher`-shaped: has
  `fetch()` but no `idFromName`) — requests go to
  `https://sandbox.internal/sandboxes/<id>/...`;
- a **Durable Object namespace** bound with `script_name` to the runtime
  Worker's `Sandbox` class (detected by `idFromName`) — the client calls
  `target.get(target.idFromName(id)).fetch(...)` with header
  `x-sandbox-id: <id>` and the path without the `/sandboxes/<id>` prefix.

```jsonc
// Option A: Service Binding
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }] }

// Option B: Durable Object namespace (no migration needed in the caller)
{
  "durable_objects": {
    "bindings": [{ "name": "SANDBOX", "class_name": "Sandbox", "script_name": "sandbox-javascript" }],
  },
}
```

## API

```ts
const sandbox = getSandbox(env.SANDBOX, "user-42", { normalizeId: true });

sandbox.id;                                                          // string

await sandbox.createCodeContext({ language, cwd, envVars });         // Promise<CodeContext>
await sandbox.listCodeContexts();                                    // Promise<CodeContext[]>
await sandbox.deleteCodeContext(ctx.id);                             // Promise<void>
await sandbox.runCode(code, {
  context, language, envVars, timeout, signal,
  onStdout, onStderr, onResult, onError,
});                                                                   // Promise<ExecutionResult>
await sandbox.setEnvVars({ NAME: "value", OLD: undefined });         // Promise<void>; undefined unsets a key

await sandbox.writeFile(path, content, { encoding });                // Promise<WriteFileResult>; content: string | Uint8Array
await sandbox.readFile(path, { encoding });                          // Promise<ReadFileResult>
await sandbox.mkdir(path, { recursive });                            // Promise<MkdirResult>
await sandbox.deleteFile(path, { recursive, force });                // Promise<DeleteFileResult>
await sandbox.renameFile(oldPath, newPath);                          // Promise<RenameFileResult>
await sandbox.moveFile(sourcePath, destinationPath);                 // Promise<MoveFileResult>
await sandbox.listFiles(path, { recursive, includeHidden });         // Promise<ListFilesResult>
await sandbox.exists(path);                                          // Promise<FileExistsResult>

await sandbox.getInfo();                                             // Promise<SandboxInfo>
await sandbox.destroy();                                             // Promise<void>; deletes the sandbox
```

`CodeContext` is `{ id, language, cwd, createdAt: Date, lastUsed: Date }`.
`runCode` without `context` uses (or creates) the default context for the
requested/runtime language; `onStdout`/`onStderr`/`onResult`/`onError` fire
after the response arrives — there is no streaming. Files live only under
`/workspace`, shared by every context in the sandbox (1 MiB per file, 16 MiB
per workspace, 4096 entries). A sandbox holds at most 8 code contexts, with
one interpreter resident in memory at a time; others are restored from their
snapshot on next use.

## Errors

Every non-200 response is an `ErrorResponse` (`{ code, message, context,
httpStatus, timestamp, operation? }`); the client throws the matching
`SandboxError` subclass:

- `FileNotFoundError`, `FileExistsError`, `FileTooLargeError`,
  `PermissionDeniedError`, `FileSystemError` — file operations
  (`error.context.path`, `.operation`, and, for filesystem failures, the
  Node-style errno in `error.context.errno`)
- `ContextNotFoundError` — `error.context.contextId`
- `ValidationFailedError` — malformed requests
- `CodeExecutionError` — the engine failed before producing a result
- `SandboxError` — the base class; also thrown for a non-JSON or malformed
  error body, with `code: "INTERNAL_ERROR"`

```ts
import { FileNotFoundError } from "@sandbox-workers/core";

try {
  await sandbox.readFile("/workspace/missing.txt");
} catch (error) {
  if (error instanceof FileNotFoundError) {
    // error.code === "FILE_NOT_FOUND", error.httpStatus === 404
  }
}
```

See the [code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/code-contexts.md)
for per-language REPL semantics, the
[HTTP API reference](https://github.com/syumai/sandbox-workers/blob/main/website/content/api/http-api.md)
for the full HTTP contract, and the
[code contexts concept page](https://github.com/syumai/sandbox-workers/blob/main/website/content/concepts/code-contexts.md)
for the snapshot mechanism.
