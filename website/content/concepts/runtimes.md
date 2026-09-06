---
title: Runtime engines
description: How each language's Wasm engine is instrumented, capped, and isolated.
---

Each supported language — JavaScript, Python, Perl, and Ruby — is a completely separate Wasm Worker with its own engine build. There is no shared runtime process: every execution gets a fresh Wasm instance and fresh linear memory, and nothing from a previous call is retained outside of a [code context](/concepts/code-contexts)'s stored snapshot. For per-language details (versions, stdlib coverage, examples), see the [runtimes section](/runtimes/javascript); for the exact size, memory, and fuel numbers, see [Limits](/platform/limits).

## Fuel instrumentation

Every engine is fuel-instrumented at build time by `scripts/instrument.mjs`, using Binaryen to insert a metering call at every function entry and every loop. This stops synchronous infinite loops that timers alone cannot interrupt, and it caps how much guest computation a single execution can perform. Fuel measures neither instructions nor milliseconds, and it does not account for all work performed by individual bulk-memory instructions, so fuel budgets and execution speeds are not directly comparable across languages — fuel also includes each interpreter's own startup and standard-library loading cost.

Each language has its own fuel budget:

| Language | Fuel budget |
| --- | --- |
| JavaScript | 50,000,000 |
| Python | 100,000,000 |
| Perl | 10,000,000 |
| Ruby | 30,000,000 |

JavaScript's fuel exhaustion works differently from the other three. Rather than a synchronous trap, the host writes SpiderMonkey's own interrupt words once the budget hits zero and lets execution continue until SpiderMonkey observes the request at its own periodic check, with a hard backstop that throws `ExecutionLimitError` if ticking continues for another full budget past zero. This is also why a JavaScript context's interpreter survives fuel exhaustion where Python's and Perl's do not (see [Code contexts](/concepts/code-contexts)).

## Memory caps

Binaryen also caps each engine's Wasm linear memory at build time: 64 MiB for JavaScript, Python, and Perl, and 96 MiB for Ruby. JavaScript additionally enforces its own 32 MiB heap cap and 1 MiB native stack quota when a runtime handle is created (`js_new`), so GC allocation failures and runaway recursion inside the JavaScript engine surface as catchable guest errors (`InternalError`) rather than trapping the whole instance.

## The WASI adapter

Every engine runs behind a WASI adapter that exposes a virtual, **read-only** standard library and `/dev/null`. There are no host files, no sockets, no process creation, and no way to install packages (`pip`, `CPAN`, `gem`) or load native/dynamic extensions from inside the guest. Ruby's embedded filesystem stays entirely inside its own instance.

## Output accumulation

Python and Perl's upstream ABI captures stdout until the execution completes, so output accumulates in Wasm memory and against the fuel budget for the whole run before the host checks it against the output limit. Ruby's output is limited as it is written instead.

## Language-specific limitations

- **Python** — this build has unresolved `mpdecimal` imports in `_decimal`, so `decimal`, `fractions`, and `statistics` are unsupported.
- **JavaScript** — submitted code may be TypeScript: unrecognized syntax is passed through sucrase, which strips TypeScript-only syntax without performing any type checking, so a TypeScript type error still runs like any other JavaScript code rather than being caught ahead of time.

## The two host ABIs

JavaScript, Python, and Perl share the same wasmify protobuf ABI; Ruby uses the official RubyVM ABI instead. See [Architecture](/concepts/architecture) for how that fits into the request flow.

## Related resources

- [JavaScript runtime](/runtimes/javascript), [Python runtime](/runtimes/python), [Perl runtime](/runtimes/perl), [Ruby runtime](/runtimes/ruby)
- [Limits](/platform/limits) - the full size, memory, and fuel tables
- [Architecture](/concepts/architecture)
- [Security model](/concepts/security)
