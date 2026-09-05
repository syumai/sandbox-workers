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
