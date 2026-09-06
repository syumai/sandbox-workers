---
title: Documentation
description: Run code in isolated language engines on your own Cloudflare account.
---

sandbox-workers packages JavaScript, Python, Perl, and Ruby interpreters as separate Wasm Workers. Your application sends a code script and string env vars through a Service Binding and receives the value of the last expression, captured output, and any error.

## Start here

- [Playground](/): try every runtime in the browser before deploying.
- [Quickstart](/getting-started/quickstart): deploy an engine and run your first request.
- [Deploy to Cloudflare](/getting-started/deploy): one button per runtime, with no local toolchain.
- [CLI](/getting-started/cli): initialize a Worker from a published runtime package.
- [Service Bindings](/guides/service-bindings): connect your application without exposing the engine publicly.
- [API reference](/reference/api): request fields, responses, and error handling.

## Choose an engine

| Runtime                            | Engine                       | Env vars accessed as |
| ---------------------------------- | ---------------------------- | --------------------- |
| [JavaScript](/runtimes/javascript) | SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6 | `process.env.NAME`    |
| [Python](/runtimes/python)         | CPython 3.14.6               | `os.environ["NAME"]`  |
| [Perl](/runtimes/perl)             | Perl 5.42.2                  | `$ENV{NAME}`          |
| [Ruby](/runtimes/ruby)             | CRuby 4.0.0                  | `ENV["NAME"]`         |

Every run creates a fresh Wasm instance. Fuel, memory, and output bounds limit guest execution. Standard libraries depend on the selected engine; host networking, host files, and package installation are unavailable.

The npm packages are currently previews and have not been published. Source-based deployment templates work independently of npm publication once this repository and the template directories are public. Read [runtime licenses](/reference/licenses) and [limits](/reference/limits) before use.
