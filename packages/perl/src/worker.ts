import wasm from "./engine.wasm";
import archive from "./stdlib.bin";
import build from "./engine-build.json";
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { perlRuntime } from "./metadata.js";
import {
  runEmbedded,
  createEmbeddedSession,
  restoreEmbeddedSession,
} from "../../../runtime/embedded.mjs";

const engine: Engine = {
  language: perlRuntime.id,
  engineName: perlRuntime.engine,
  build: build.sha256,
  limits: perlRuntime.limits,
  run: (payload) => runEmbedded(wasm, archive, "perl", payload),
  sessions: {
    boot: (options) => createEmbeddedSession(wasm, archive, "perl", options),
    restore: (options, snapshot) => restoreEmbeddedSession(wasm, archive, "perl", { ...options, snapshot }),
  },
};

const { Worker, Interpreter } = defineInterpreterRuntime(engine);
export { Interpreter };
export default Worker;
