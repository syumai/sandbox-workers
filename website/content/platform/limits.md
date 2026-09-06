---
title: Limits
description: Engine budgets, request and workspace limits, and the PHP evaluation.
---

| Package                     | Engine                         | Uncompressed Worker size (approx.) | Wasm memory cap | Fuel        |
| --------------------------- | ------------------------------ | ---------------------------------- | ---------------- | ----------- |
| @sandbox-workers/javascript | SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6 | 26.70 MiB        | 64 MiB          | 50,000,000  |
| @sandbox-workers/python     | CPython 3.14.6 / goccy v0.2.0  | 7.80 MiB                           | 64 MiB          | 100,000,000 |
| @sandbox-workers/perl       | Perl 5.42.2 / goccy v0.2.1     | 14.04 MiB                          | 64 MiB          | 10,000,000  |
| @sandbox-workers/ruby       | CRuby 4.0.0 / ruby.wasm 2.10.1 | 31.22 MiB                          | 96 MiB          | 30,000,000  |

Sizes were measured with Wrangler dry-run on September 5, 2026. The gateway is approximately 6 KiB; each engine lives in its own Worker behind a Service Binding. Cloudflare's [64 MiB limit](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/) applies to the uncompressed bundle and replaces the previous gzip limits. Standard libraries shipped as zip assets count toward bundle size as well.

## Request, output, and result limits

Code is limited to 64 KiB and the request to 96 KiB. Python, Perl, and Ruby stdout/stderr is limited to 32 KiB and 200 log chunks combined; JavaScript console capture uses the same limits. The serialized result is capped at 64 KiB. See [HTTP API](/api/http-api) for the full request and response shapes, and [Interpreter](/api/interpreter) for how a fuel, output, or result limit is reported through `ExecutionResult`.

## Sandboxes and code contexts

Sandboxes (JavaScript, Python, Perl; not Ruby) add limits on top of the execution limits above: at most 8 code contexts per sandbox, with only 1 interpreter resident in memory at a time (the rest are restored from their snapshot on next use). The shared `/workspace` is limited to 1 MiB per file, 16 MiB total, and 4096 entries. See [Code contexts](/concepts/code-contexts) for the full contract and [Files](/api/files) for the files API.

## Isolation and compatibility

Each execution creates a fresh Wasm instance and memory; no context persists between calls outside a code context. Host environment variables and secrets are never passed to the guest — only the key/value pairs supplied in `envVars` are visible. See [Runtimes](/concepts/runtimes) for engine internals (fuel instrumentation, memory caps, the WASI virtual filesystem, and per-language ABI) and [Security](/concepts/security) for the isolation model and unsupported capabilities.

## PHP evaluation

The PHP 8.5 Emscripten build in `php-wasm@0.1.0` was evaluated. Its Wasm is approximately 17 MiB, but it requires 128 MiB of initial linear memory. The Workers isolate also needs memory for the JavaScript host and other overhead, so this build was not adopted. An adapter would also need to block Emscripten's host JavaScript evaluation, network access, and dynamic-library paths.

A build with smaller initial memory, fewer extensions, and a restricted WASI or Emscripten host remains a possible next step. The archived PHP 8.2.6 build was not adopted as a substitute. Currently, `php` is absent from `/languages` and is rejected as unsupported by the API.

## Validation scope

Tests execute real Wasm under Node and cover JSON, Unicode, stdout, errors, fuel limits, denied host access, and shipped examples. Validation also covers HTTP execution through all four Service Bindings in local workerd, type checking, the UI build, browser sample execution, independent package installation, and dry-run builds for every Worker.

The packages have not been published to npm or deployed to production. A Paid plan is intended for execution because interpreter startup can exceed the Free plan's CPU budget. Production CPU usage, concurrent workloads, and long-running operations still require measurement.
