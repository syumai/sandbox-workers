import wasm from "./engine.wasm";
import archive from "./stdlib.bin";
import build from "./engine-build.json";
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { runWasmify, bootWasmifySession, restoreWasmifySession } from "@sandbox-workers/interpreter/wasmify";
import { perlRuntime } from "./metadata.js";
import { perlDriver } from "./engine.mjs";

const engine: Engine = {
  language: perlRuntime.id,
  engineName: perlRuntime.engine,
  build: build.sha256,
  limits: perlRuntime.limits,
  run: (payload) => runWasmify(wasm, archive, perlDriver, payload, perlRuntime.limits),
  sessions: {
    boot: (options) => bootWasmifySession(wasm, archive, perlDriver, options, perlRuntime.limits),
    restore: (options, snapshot) =>
      restoreWasmifySession(wasm, archive, perlDriver, options, snapshot, perlRuntime.limits),
  },
};

const { Worker, Interpreter } = defineInterpreterRuntime(engine);
export { Interpreter };
export default Worker;
