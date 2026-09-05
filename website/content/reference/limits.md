---
title: Limits and compatibility
description: Engine budgets, supported capabilities, and the PHP evaluation.
---

| Package                     | Engine                         | Uncompressed Worker size (approx.) | Wasm memory cap | Fuel        |
| --------------------------- | ------------------------------ | ---------------------------------- | --------------- | ----------- |
| @sandbox-workers/javascript | SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6 | 26.70 MiB        | 64 MiB          | 50,000,000  |
| @sandbox-workers/python     | CPython 3.14.6 / goccy v0.2.0  | 7.80 MiB                           | 64 MiB          | 100,000,000 |
| @sandbox-workers/perl       | Perl 5.42.2 / goccy v0.2.1     | 14.04 MiB                          | 64 MiB          | 10,000,000  |
| @sandbox-workers/ruby       | CRuby 4.0.0 / ruby.wasm 2.10.1 | 31.22 MiB                          | 96 MiB          | 30,000,000  |

Sizes were measured with Wrangler dry-run on September 5, 2026. The gateway is approximately 6 KiB; each engine lives in its own Worker behind a Service Binding. Cloudflare's [64 MiB limit](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/) applies to the uncompressed bundle and replaces the previous gzip limits. Standard libraries shipped as zip assets count toward bundle size as well.

## Execution contract

Send `{ language, code, envVars }` to `POST /execute`. Supported language IDs are `javascript`, `python`, `perl`, and `ruby`. Omitting the language selects JavaScript at the gateway, or the individual runtime's language when calling a runtime Worker directly.

Code is a **script**: the value of the last top-level expression is the result; a top-level `return` is not part of the supported contract in any language. Data is passed with `envVars` (string values only) and read as `process.env.NAME` (JavaScript), `os.environ["NAME"]` (Python), `$ENV{NAME}` (Perl), or `ENV["NAME"]` (Ruby).

Code is limited to 64 KiB and the request to 96 KiB. Python, Perl, and Ruby stdout/stderr is limited to 32 KiB and 200 log chunks combined; JavaScript console capture uses the same limits. The serialized result is capped at 64 KiB. Every execution — success, guest error, or a fuel/output/result limit — returns HTTP 200 with `{ code, language, engine, durationMs, logs: { stdout, stderr }, results, error?, usage? }`; check the `error` field through the shared client. Only request/transport failures (bad JSON, unsupported language, invalid `envVars`, an `input` key, wrong method, oversized payload, wrong content type, or a gateway failure) use non-200 statuses with `{ error: { name: "ApiError", message } }`.

## Isolation and compatibility

Each execution creates a fresh Wasm instance and memory; no context persists between calls. Host environment variables and secrets are never passed to the guest — only the key/value pairs supplied in `envVars` are visible. The WASI adapter exposes a virtual standard library and `/dev/null`, without host files, sockets, or process creation. Python and Perl libraries are read-only. Ruby's embedded filesystem stays inside its instance. Ruby's JavaScript bridge is disabled, and its asynchronous initialization is serialized to avoid overlapping guest memories within one isolate.

Binaryen inserts fuel callbacks at function entries and loops and caps Wasm memory pages. This stops synchronous infinite loops that timers alone cannot interrupt. Fuel includes interpreter startup and standard-library loading, so fuel values and execution speeds cannot be compared directly across languages.

Python and Perl use goccy's protobuf ABI; Ruby uses the official RubyVM ABI. This Python build has unresolved mpdecimal imports in `_decimal`, so `decimal`, `fractions`, and `statistics` are also unsupported. Unimplemented host capabilities fail explicitly. Installing pip, CPAN, or gem packages, adding arbitrary native extensions, and accessing network or OS services are unsupported.

Python and Perl's upstream ABI captures stdout until execution completes. Wasm memory and fuel bound that accumulation, and the host checks output limits afterward. Ruby output is limited as it is written. Result serialization and parsing also have size bounds.

## PHP evaluation

The PHP 8.5 Emscripten build in `php-wasm@0.1.0` was evaluated. Its Wasm is approximately 17 MiB, but it requires 128 MiB of initial linear memory. The Workers isolate also needs memory for the JavaScript host and other overhead, so this build was not adopted. An adapter would also need to block Emscripten's host JavaScript evaluation, network access, and dynamic-library paths.

A build with smaller initial memory, fewer extensions, and a restricted WASI or Emscripten host remains a possible next step. The archived PHP 8.2.6 build was not adopted as a substitute. Currently, `php` is absent from `/languages` and is rejected as unsupported by the API.

## Validation scope

Tests execute real Wasm under Node and cover JSON, Unicode, stdout, errors, fuel limits, denied host access, and shipped examples. Validation also covers HTTP execution through all four Service Bindings in local workerd, type checking, the UI build, browser sample execution, independent package installation, and dry-run builds for every Worker.

The packages have not been published to npm or deployed to production. A Paid plan is intended for execution because interpreter startup can exceed the Free plan's CPU budget. Production CPU usage, concurrent workloads, and long-running operations still require measurement.
