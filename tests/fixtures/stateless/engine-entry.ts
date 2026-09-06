// Stateless-mode runtime Worker fixture for tests/stateless.mjs: exports
// only `default` from @sandbox-workers/javascript (no `Sandbox` Durable
// Object class), so this Worker can be deployed without a durable_objects
// binding/migration -- mirroring what the CLI's --stateless flag
// (packages/cli/bin/cli.mjs) generates for a non-ruby runtime. See
// docs/sdk-parity-design.md, "Stateless mode".
export { default } from "@sandbox-workers/javascript";
