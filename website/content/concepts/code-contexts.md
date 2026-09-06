---
title: Code contexts
description: Durable REPLs and the memory-snapshot mechanism that keeps them alive.
---

A **code context** is a named, durable REPL that lives inside a sandbox. One execution's top-level variables, functions, classes, and imported modules are visible to the next execution in the same context, the same way a browser console or a language's interactive shell keeps state between commands you type into it.

A sandbox holds at most **8 code contexts**, with only **1 interpreter resident in memory** at a time — the rest are restored from their snapshot the next time they're used. `runCode` without an explicit context uses (or creates) the sandbox's default context for the requested language, so simple callers never need to think about contexts at all.

For how to create, list, and delete contexts, and per-language REPL semantics, see [Use code contexts](/guides/code-contexts) and [API: interpreter](/api/interpreter).

## Memory snapshots

A code context's globals (not just its sandbox's `/workspace`) survive Durable Object eviction, hibernation, and redeploys: after each execution that leaves the interpreter in a safe, resumable state, the runtime Worker takes a snapshot of the engine's linear memory and writes it to the Durable Object's own SQLite storage, alongside the workspace files. The next time that context is used — even from a brand-new Durable Object instance — the engine is restored from that snapshot instead of booting fresh, so top-level variables, functions, classes, and imported modules are exactly as a prior execution left them.

A few things follow from how this works:

- **A snapshot is skipped, never corrupted, after a trap.** Fuel exhaustion in Python and Perl, and any other unrecoverable engine error, both throw away the live interpreter; the *next* execution in that context boots a fresh one from the most recent snapshot (or from scratch, if there is none yet) — nothing from the failed execution's globals survives, but the context keeps working. JavaScript's fuel-exhaustion interrupt is different: the interpreter is not corrupted by it, so the context stays live and stays snapshottable.
- **A snapshot is skipped, and the existing one is flagged stale, if the guest still holds an open file descriptor** when an execution finishes (for example, Python or Perl code that calls `open()` without closing the result). The execution's result is unaffected, but restoring the snapshot later would replay an older memory image than what that execution actually produced — the sandbox's info reports that context's `snapshot.stale: true` until a later execution snapshots cleanly again.
- **Memory never shrinks.** Once a context's linear memory has grown, later executions keep paying for that page count even if they use less. Deleting the context and creating a new one is the way to compact: it drops both the live interpreter and the stored snapshot for that context (`/workspace` is untouched, since it belongs to the sandbox), so the next execution in the new context starts from a fresh, minimum-size interpreter.
- **A stored snapshot is discarded, not restored, if the engine build changed** (a redeploy with different engine code). The sandbox's info then reports that context's `snapshot: null` until the next execution's memory image is snapshotted from scratch.
- **`Math.random()`'s sequence repeats after a restore.** A restored JavaScript engine resumes its pseudo-random generator from exactly the state it was in when the snapshot was taken, so code that calls `Math.random()` right after a restore can see the same values it would have seen right after the original snapshot. Python's `random` module is reseeded automatically after every restore, so it doesn't have this issue; Perl code that needs fresh entropy across a restore should call `srand()` itself.

An execution that actually wrote a snapshot reports how long that took in `context.snapshotMs` (milliseconds) — useful for measuring the cost of a particular context's workload, not something callers need to act on.

## Why Ruby is unsupported

Ruby has no code contexts: every `/sandboxes/:id/*` route on a Ruby runtime Worker is rejected (aside from context-less, stateless execution). Ruby's initial memory footprint (35.6 MiB) and `RubyVM`'s host-side state rule out the memory-snapshot mechanism the other three languages use, so there is no way to durably restore a Ruby interpreter between requests.

## See also

- [Use code contexts](/guides/code-contexts) - how to create, list, and delete contexts
- [API: interpreter](/api/interpreter) - method signatures and the `ExecutionResult`/`CodeContext` types
- [`docs/sdk-parity-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sdk-parity-design.md) - the full design document for this API surface
- [`docs/sessions-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/sessions-design.md) - the Durable Object's internal storage layout and the memory-snapshot mechanism in more detail
- [`docs/snapshot-cost-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/snapshot-cost-design.md) - the later storage-cost changes: 1 MiB chunk rows, the folded-in snapshot record, and throttled idle expiry
