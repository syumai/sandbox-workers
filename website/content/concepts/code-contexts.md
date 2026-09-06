---
title: Code contexts
description: Durable REPLs bound to a runtime Worker, the shared workspace mirror, and the memory-snapshot mechanism that keeps them alive.
---

A **code context** is a named, durable REPL bound to one runtime Worker by the **name of a Service Binding** — there is no `language` option, and the binding determines it. One execution's top-level variables, functions, classes, and imported modules are visible to the next execution in the same context, the same way a browser console or a language's interactive shell keeps state between commands you type into it.

A sandbox can hold contexts of **several bindings at once** — one language per context, but many languages per sandbox — all sharing the sandbox's single `/workspace`. A sandbox holds at most **8 code contexts across all bindings**, with only **1 interpreter resident in memory per runtime Worker** at a time — the rest are restored from their snapshot the next time they're used. `runCode` without an explicit `context` requires `binding` and uses (or creates) that binding's default context, so simple callers never need to think about contexts at all.

For how to create, list, and delete contexts, and per-language REPL semantics, see [Use code contexts](/guides/code-contexts) and [API: interpreter](/api/interpreter).

## The shared workspace mirror

`/workspace` has exactly one source of truth: the caller's `Sandbox` Durable Object. Each context's runtime Worker keeps its own in-memory mirror of it, since that's what the guest's `fs`/`open()` calls actually read and write against. That mirror is brought up to date **inside every execute request**: the sandbox sends a manifest of every file's content hash plus the contents of anything the runtime Worker might not have yet, the runtime Worker reconciles its mirror before running the code, and the guest's changes flow back in the response for the sandbox to persist. This is why a Python context can `open()` a file a JavaScript context wrote with `fs.writeFileSync` in the same sandbox — both contexts' mirrors reconcile against the same underlying tree, just at different times (whenever each binding's context next executes).

If a runtime Worker's `Interpreter` was evicted and its mirror is stale, the reconciliation step detects the mismatch and asks the sandbox to resend the missing files rather than running against wrong data — this is transparent to callers; it costs one extra round trip on the first execution after an eviction.

## Memory snapshots

A code context's globals (not just its sandbox's `/workspace`) survive Durable Object eviction, hibernation, and redeploys: after each execution that leaves the interpreter in a safe, resumable state, the runtime Worker's `Interpreter` Durable Object takes a snapshot of the engine's linear memory and writes it to its own SQLite storage. The next time that context is used — even from a brand-new `Interpreter` instance — the engine is restored from that snapshot instead of booting fresh, so top-level variables, functions, classes, and imported modules are exactly as a prior execution left them.

A few things follow from how this works:

- **A snapshot is skipped, never corrupted, after a trap.** Fuel exhaustion in Python and Perl, and any other unrecoverable engine error, both throw away the live interpreter; the *next* execution in that context boots a fresh one from the most recent snapshot (or from scratch, if there is none yet) — nothing from the failed execution's globals survives, but the context keeps working. JavaScript's fuel-exhaustion interrupt is different: the interpreter is not corrupted by it, so the context stays live and stays snapshottable.
- **A snapshot is skipped, and the existing one is flagged stale, if the guest still holds an open file descriptor** when an execution finishes (for example, Python or Perl code that calls `open()` without closing the result). The execution's result is unaffected, but restoring the snapshot later would replay an older memory image than what that execution actually produced — `sandbox.getInfo()` reports that context's `snapshot.stale: true` until a later execution snapshots cleanly again.
- **Memory never shrinks.** Once a context's linear memory has grown, later executions keep paying for that page count even if they use less. Deleting the context and creating a new one is the way to compact: it drops both the live interpreter and the stored snapshot for that context on its runtime Worker (`/workspace` is untouched, since it belongs to the sandbox), so the next execution in the new context starts from a fresh, minimum-size interpreter.
- **A stored snapshot is discarded, not restored, if the engine build changed** (a redeploy of the runtime Worker with different engine code). `sandbox.getInfo()` then reports that context's `snapshot: null` until the next execution's memory image is snapshotted from scratch.
- **`Math.random()`'s sequence repeats after a restore.** A restored JavaScript engine resumes its pseudo-random generator from exactly the state it was in when the snapshot was taken, so code that calls `Math.random()` right after a restore can see the same values it would have seen right after the original snapshot. Python's `random` module is reseeded automatically after every restore, so it doesn't have this issue; Perl code that needs fresh entropy across a restore should call `srand()` itself.

An execution that actually wrote a snapshot reports how long that took in `context.snapshotMs` (milliseconds) — useful for measuring the cost of a particular context's workload, not something callers need to act on.

## Why Ruby is unsupported

Ruby's runtime Worker always reports `contexts: false` from `GET /interpreter`: `createCodeContext({ binding: "RUBY" })` fails, and `runCode({ binding: "RUBY" })` (no context) runs statelessly instead. Ruby's initial memory footprint (35.6 MiB) and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other three languages use, so there is no way to durably restore a Ruby interpreter between requests. A runtime Worker deployed with `--stateless` reports the same `contexts: false`, regardless of language.

## See also

- [Use code contexts](/guides/code-contexts) - how to create, list, and delete contexts, and use several languages in one sandbox
- [API: interpreter](/api/interpreter) - method signatures and the `ExecutionResult`/`CodeContext` types
- [Architecture](/concepts/architecture) - the `Sandbox`/`Interpreter` split this all runs on
- [`docs/sandbox-1-0-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sandbox-1-0-design.md) - the full design document for this API surface, including the workspace sync wire protocol
- [`docs/sessions-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sessions-design.md) - the Durable Object's internal storage layout and the memory-snapshot mechanism in more detail
- [`docs/snapshot-cost-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/snapshot-cost-design.md) - the later storage-cost changes: 1 MiB chunk rows, the folded-in snapshot record, and throttled idle expiry
