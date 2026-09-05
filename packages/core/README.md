# @sandbox-workers/core

Typed HTTP Service Binding client and shared execution protocol. This package
contains **no Wasm engine**. Deploy a runtime Worker separately and add a binding:

```jsonc
// Caller wrangler.jsonc (merge into your existing configuration)
{ "services": [{ "binding": "SANDBOX", "service": "sandbox-javascript" }] }
```

```ts
import { createSandbox } from "@sandbox-workers/core";

export default {
  async fetch(request, env) {
    const sandbox = createSandbox(env.SANDBOX, "javascript");
    const result = await sandbox.runCode(
      "const x = Number(process.env.X);\nx ** 2",
      { envVars: { X: "12" } },
    );
    return Response.json(result);
  },
};
```

`runCode(code, { envVars })` resolves to an `ExecutionResult`. Code is a
script — the value of the last expression is the result. Guest failures and
resource limits (fuel, output, result size) set `result.error` instead of
throwing; binding/network failures reject, and malformed responses or HTTP
5xx throw `SandboxTransportError`. There is no `ok` field.
`createSandbox(binding, language)` supports JavaScript, Python, Perl, Ruby, and
additional runtime Workers implementing the same `{ language, code, envVars }` / `ExecutionResult` contract.
Every call boots a fresh Wasm instance; no context persists between calls.

The client calls only the supplied binding; it never sends code to the public
Playground. See the runtime package documentation for limits and compatibility.

## Sessions

`runCode` is stateless: every call boots a fresh Wasm instance. `sandbox.session(id)`
returns a durable, stateful REPL instead, backed by a Durable Object the runtime
Worker exports (JavaScript, Python, and Perl; **not** Ruby). Top-level variables,
functions, and a writable `/workspace` persist across calls to the same session id,
surviving Durable Object eviction, hibernation, and redeploys via a linear-memory
snapshot taken after each execution.

```ts
const session = sandbox.session("user-42"); // validated against /^[A-Za-z0-9._-]{1,128}$/

await session.runCode(code, { envVars, cwd }); // ExecutionResult + { session: { id, cwd, executions } }
await session.info(); // SessionInfo
await session.reset(); // drops the live instance, keeps files and cwd
await session.destroy(); // deletes all session storage

await session.readFile(path, { encoding }); // ReadFileResult
await session.writeFile(path, content, { encoding }); // string or Uint8Array -> { size }
await session.listFiles(path, { recursive }); // FileEntry[]
await session.deleteFile(path, { recursive, force });
await session.renameFile(from, to);
await session.mkdir(path, { recursive });
await session.exists(path); // boolean
await session.stat(path); // FileStat
```

File operation failures throw `SandboxFileError` (`code`, e.g. `ENOENT`/`EEXIST`,
and `status`), distinct from `SandboxTransportError` for binding/network failures.
The runtime Worker's own `wrangler.jsonc` needs a `SESSIONS` Durable Object binding
(`SandboxSession`, with a `new_sqlite_classes` migration) — the calling
application's configuration is unchanged, it still only needs the plain Service
Binding above. See the [sessions guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/sessions.md)
for the HTTP contract, the files API, and per-language REPL semantics.
