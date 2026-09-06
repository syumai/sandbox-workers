---
title: API reference
description: Method signatures, types, and the raw HTTP contract for @sandbox-workers/core.
---

This section documents the `@sandbox-workers/core` typed client and the JSON HTTP contract it sits on top of, for every method, option, result shape, and error you'll encounter. For task-oriented walkthroughs, see [Stateless mode](/stateless) and [Stateful mode](/stateful) instead.

- [Lifecycle](/api/lifecycle) — `getSandbox()`, `sandbox.id`, `sandbox.getInfo()`, `sandbox.destroy()`, and the `SandboxInfo` shape (**stateful mode**)
- [Code interpreter](/api/interpreter) — `sandbox.interpreter.*`: `createCodeContext()`, `listCodeContexts()`, `deleteCodeContext()`, `runCode()` (**stateful mode**), plus `sandbox.setEnvVars()` (stateful mode) and the free `runCode()` (**stateless mode**)
- [Files](/api/files) — the workspace filesystem: `writeFile()`, `readFile()`, `mkdir()`, `deleteFile()`, `renameFile()`, `moveFile()`, `listFiles()`, `exists()` (**stateful mode**)
- [Errors](/api/errors) — the `SandboxError` hierarchy, the `ErrorResponse` shape, and the full error code table (**both modes**)
- [HTTP API](/api/http-api) — the raw JSON contract behind the client, on both sides of the wire (**both modes**)

## Related resources

- [Stateless mode](/stateless) — task-oriented how-tos for one-shot execution with the free `runCode`
- [Stateful mode](/stateful) — task-oriented how-tos for code contexts and the shared workspace
- [Concepts](/concepts) — architecture, sandbox lifecycle, code contexts, runtimes, and the security model
- [Configuration](/configuration) — the caller's and runtime Worker's `wrangler.jsonc`, bindings, and environment variables
