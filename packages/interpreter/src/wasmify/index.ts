// `@sandbox-workers/interpreter/wasmify`: the protobuf-ish ABI goccy's
// Python and Perl Wasm builds share ("wasmify"), plus the language-neutral
// embedded-interpreter session host built on it. See README.md's
// "Wasm-based engines" section and `packages/python/src/engine.mjs` /
// `packages/perl/src/engine.mjs` for the language-specific `WasmifyDriver`
// each build.
export { message, invoke, type MessageField, type DecodedMessage } from "./protobuf.js";
export {
  runWasmify,
  bootWasmifySession,
  restoreWasmifySession,
  ExecutionLimitError,
  type WasmifyDriver,
  type WasmifyContext,
} from "./embedded.js";
