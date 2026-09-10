import wasm from "./engine.wasm";
import archive from "./stdlib.bin";
import build from "./engine-build.json";
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { pythonRuntime } from "./metadata.js";
import {
  runEmbedded,
  createEmbeddedSession,
  restoreEmbeddedSession,
} from "../../../runtime/embedded.mjs";

const engine: Engine = {
  language: pythonRuntime.id,
  engineName: pythonRuntime.engine,
  build: build.sha256,
  limits: pythonRuntime.limits,
  run: (payload) => runEmbedded(wasm, archive, "python", payload),
  sessions: {
    boot: (options) => createEmbeddedSession(wasm, archive, "python", options),
    restore: (options, snapshot) => restoreEmbeddedSession(wasm, archive, "python", { ...options, snapshot }),
  },
};

const { Worker, Interpreter } = defineInterpreterRuntime(engine);
export { Interpreter };
export default Worker;
