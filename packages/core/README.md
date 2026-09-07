# @sandbox-workers/core

Shared execution protocol, `Workspace` module, and the typed client and
Durable Object for the **Sandbox SDK 1.0**-style API (see
`docs/sandbox-1-0-design.md`). This package contains **no Wasm engine**:
deploy a runtime Worker (`@sandbox-workers/javascript`, `python`, `perl`, or
`ruby`) separately, one per language, and bind it as a Service Binding in
your own Worker.

## Model

Your Worker hosts the `Sandbox` Durable Object (exported from this package)
and calls `getSandbox(env.Sandbox, id)` to get a typed client. A sandbox owns
`/workspace` and a registry of **code contexts**; each context is bound to a
runtime Worker by the **name of a Service Binding** in your own environment
(`createCodeContext({ binding: "PYTHON" })`) — there is no `language` option.
One sandbox can hold contexts of several languages at once, all sharing the
same `/workspace`.

```jsonc
// your wrangler.jsonc
{
  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "services": [
    { "binding": "PYTHON", "service": "sandbox-python" },
    { "binding": "JAVASCRIPT", "service": "sandbox-javascript" },
  ],
  "vars": {
    "SANDBOX_IDLE_TTL_MS": "86400000", // optional; "0" disables expiry
    // "SANDBOX_FILE_API": "disabled", // optional; turns the File API off, see docs/sandbox-1-0-design.md
  },
}
```

```ts
// your Worker's entry
export { Sandbox } from "@sandbox-workers/core";
```

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.Sandbox, "user-42");
const py = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });
const js = await sandbox.interpreter.createCodeContext({ binding: "JAVASCRIPT" });

await sandbox.interpreter.runCode("open('/workspace/a.txt','w').write('hi')", { context: py });
await sandbox.interpreter.runCode("fs.readFileSync('/workspace/a.txt','utf8')", { context: js });
await sandbox.interpreter.runCode("1 + 1", { binding: "PYTHON" }); // default context for PYTHON

await sandbox.setEnvVars({ TOKEN: "abc", OLD: undefined });
await sandbox.writeFile("/workspace/a.txt", "hi");
await sandbox.getInfo();
await sandbox.destroy();
```

For a stateless, one-shot alternative with no code context and no files, use
the free `runCode` against a runtime Worker's Service Binding directly:

```ts
import { runCode } from "@sandbox-workers/core";

const result = await runCode(env.PYTHON, "1 + 1", { envVars: { X: "12" } });
```

`runCode(target, code, options?)` requires a Service Binding (`Fetcher`); it
throws synchronously for a Durable Object namespace, since there's no
sandbox id to route through in stateless mode. A runtime Worker deployed
`--stateless` (or Ruby) reports `contexts: false`, so
`sandbox.interpreter.createCodeContext({ binding })` fails for it and
`sandbox.interpreter.runCode(code, { binding })` runs through the same
stateless path instead.

`getSandbox(namespace, id, options?)` validates `id` (optionally lowercasing
it first with `{ normalizeId: true }`) against
`/^[A-Za-z0-9._-]{1,63}$/`, rejects a leading/trailing hyphen, and rejects
the reserved names `www`, `api`, `admin`, `root`, `system`, `cloudflare`,
`workers` (case-insensitively) — also exported standalone as
`validateSandboxId(id)`. `namespace` must be a Durable Object namespace bound
to your own `Sandbox` class; it throws synchronously otherwise.

`getSandbox` also takes an optional `Env` type parameter: `getSandbox<Env>(env.Sandbox, id)`
types every `binding` option on `sandbox.interpreter` as `ServiceBindingName<Env>`, the names
of the Service Bindings (values with a `fetch` method) in `Env`, so a misspelled binding name
or the `Sandbox` namespace itself is a compile-time error. This is type-only — the Durable
Object still validates the binding at runtime — and since `Env` can't be inferred from
`namespace` alone, omitting it (`getSandbox(namespace, id)`) keeps `binding` as plain `string`,
exactly as before this type parameter existed.

## API

```ts
const sandbox = getSandbox<Env>(env.Sandbox, "user-42", { normalizeId: true }); // SandboxClient<ServiceBindingName<Env>>

sandbox.id;                                                                // string
sandbox.interpreter;                                                      // CodeInterpreter

await sandbox.interpreter.createCodeContext({ binding, cwd, envVars });    // Promise<CodeContext>
await sandbox.interpreter.listCodeContexts();                             // Promise<CodeContext[]>
await sandbox.interpreter.deleteCodeContext(ctx.id);                      // Promise<void>
await sandbox.interpreter.runCode(code, {
  context, binding, envVars, timeout, signal,
  onStdout, onStderr, onResult, onError,
});                                                                        // Promise<ExecutionResult>

await sandbox.setEnvVars({ NAME: "value", OLD: undefined });               // Promise<void>; undefined unsets a key

await sandbox.writeFile(path, content, { encoding });                      // Promise<WriteFileResult>; content: string | Uint8Array | ReadableStream<Uint8Array>
await sandbox.readFile(path, { encoding });                                // Promise<ReadFileResult>; { encoding: "none" } -> Promise<ReadFileStreamResult> (content: ReadableStream<Uint8Array>)
await sandbox.mkdir(path, { recursive });                                  // Promise<MkdirResult>
await sandbox.deleteFile(path, { recursive, force });                      // Promise<DeleteFileResult>
await sandbox.renameFile(oldPath, newPath);                                // Promise<RenameFileResult>
await sandbox.moveFile(sourcePath, destinationPath);                       // Promise<MoveFileResult>
await sandbox.listFiles(path, { recursive, includeHidden });               // Promise<ListFilesResult>
await sandbox.exists(path);                                                // Promise<FileExistsResult>

await sandbox.getInfo();                                                   // Promise<SandboxInfo>
await sandbox.destroy();                                                   // Promise<void>; deletes the sandbox

await runCode(env.PYTHON, code, {                                          // stateless; env.PYTHON must be a Service Binding
  envVars, timeout, signal, onStdout, onStderr, onResult, onError,
});                                                                         // Promise<ExecutionResult>
```

`CodeContext` is `{ id, binding, language, cwd, createdAt: Date, lastUsed:
Date }`. `runCode` without `context` requires `binding` and uses (or
creates) the default context for that binding;
`onStdout`/`onStderr`/`onResult`/`onError` fire after the response arrives —
there is no streaming. Files live only under `/workspace`, shared by every
context in the sandbox regardless of language (1 MiB per file, 16 MiB per
workspace, 4096 entries). A sandbox holds at most 8 code contexts across all
bindings; each runtime Worker keeps at most one interpreter instance
resident in memory, restoring others from their snapshot on next use.

## Errors

Every non-200 response is an `ErrorResponse` (`{ code, message, context,
httpStatus, timestamp, operation? }`); the client throws the matching
`SandboxError` subclass:

- `FileNotFoundError`, `FileExistsError`, `FileTooLargeError`,
  `PermissionDeniedError`, `FileSystemError` — file operations
  (`error.context.path`, `.operation`, and, for filesystem failures, the
  Node-style errno in `error.context.errno`)
- `ContextNotFoundError` — `error.context.contextId`
- `ValidationFailedError` — malformed requests, or an unknown/unsupported
  `binding`
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

See `docs/sandbox-1-0-design.md` for the full model (the sandbox/interpreter
split, the workspace mirror and sync protocol, and the wire contracts on
both sides).
