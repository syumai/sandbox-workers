---
title: API reference
description: Method signatures, types, and the raw HTTP contract for @sandbox-workers/core.
---

This section documents the `@sandbox-workers/core` typed client and the JSON HTTP contract it sits on top of, for every method, option, result shape, and error you'll encounter. For task-oriented walkthroughs, see [How-to guides](/guides) instead.

- [Lifecycle](/api/lifecycle) — `getSandbox()`, `sandbox.id`, `sandbox.getInfo()`, `sandbox.destroy()`, and the `SandboxInfo` shape
- [Code interpreter](/api/interpreter) — code contexts and `runCode()`: `createCodeContext()`, `listCodeContexts()`, `deleteCodeContext()`, `runCode()`, `setEnvVars()`, and the `ExecutionResult` shape
- [Files](/api/files) — the workspace filesystem: `writeFile()`, `readFile()`, `mkdir()`, `deleteFile()`, `renameFile()`, `moveFile()`, `listFiles()`, `exists()`
- [Errors](/api/errors) — the `SandboxError` hierarchy, the `ErrorResponse` shape, and the full error code table
- [HTTP API](/api/http-api) — the raw JSON contract for callers that don't use the typed client

## Related resources

- [Guides](/guides) — task-oriented how-tos for deploying, executing code, working with contexts, and managing files
- [Concepts](/concepts) — architecture, sandbox lifecycle, code contexts, runtimes, and the security model
- [Configuration](/configuration) — `wrangler.jsonc` bindings, transport selection, and environment variables
