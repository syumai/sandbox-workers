import wasm from "./engine.wasm";
import archive from "./stdlib.bin";
import build from "./engine-build.json";
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { runWasmify, bootWasmifySession, restoreWasmifySession } from "@sandbox-workers/interpreter/wasmify";
import { pythonRuntime } from "./metadata.js";
import { pythonDriver } from "./engine.mjs";

const engine: Engine = {
  language: pythonRuntime.id,
  engineName: pythonRuntime.engine,
  build: build.sha256,
  limits: pythonRuntime.limits,
  run: (payload) => runWasmify(wasm, archive, pythonDriver, payload, pythonRuntime.limits),
  sessions: {
    boot: (options) => bootWasmifySession(wasm, archive, pythonDriver, options, pythonRuntime.limits),
    restore: (options, snapshot) =>
      restoreWasmifySession(wasm, archive, pythonDriver, options, snapshot, pythonRuntime.limits),
  },
};

const { Worker, Interpreter } = defineInterpreterRuntime(engine);
export { Interpreter };
export default Worker;
