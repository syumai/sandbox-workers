# Changelog

## [v0.1.0](https://github.com/syumai/sandbox-workers/commits/v0.1.0) - 2026-09-08

Initial release of the `@sandbox-workers` packages on npm.

- `@sandbox-workers/javascript`, `@sandbox-workers/python`, `@sandbox-workers/perl`, `@sandbox-workers/ruby`: deployable Wasm sandbox runtime Workers with fuel metering, memory limits, and no network access, called through Cloudflare Service Bindings.
- `@sandbox-workers/core`: typed client (`runCode`, `getSandbox`) and the `Sandbox` Durable Object for stateful sandboxes: code contexts that keep interpreter state across calls (JavaScript, Python, Perl) and a `/workspace` file system shared by every context in a sandbox.
- `@sandbox-workers/cli`: `sandbox-workers init` scaffolds one private runtime Worker per language, optionally in stateless mode.
- Releases are automated with tagpr and published with npm trusted publishing.
