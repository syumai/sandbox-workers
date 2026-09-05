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
    const result = await sandbox.execute({
      code: "return input.x ** 2;",
      input: { x: 12 },
    });
    return Response.json(result);
  },
};
```

`execute<T>()` returns `ExecutionResponse<T>`, a discriminated union on `ok`.
Guest failures and resource limits return `ok: false`; binding/network failures
reject, and malformed responses or HTTP 5xx throw `SandboxTransportError`.
The generic describes your expected JSON result; it does not validate its shape.
`createSandbox(binding, language)` supports JavaScript, Python, Perl, Ruby, and
additional runtime Workers implementing the same `{ language, code, input }` / JSON-response contract.

The client calls only the supplied binding; it never sends code to the public
Playground. See the runtime package documentation for limits and compatibility.
