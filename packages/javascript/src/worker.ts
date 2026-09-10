import wasm from "./engine.wasm";
import build from "./engine-build.json";
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { javascriptRuntime } from "./metadata.js";
import {
  runJavaScript,
  createJavaScriptSession,
  restoreJavaScriptSession,
} from "../../../runtime/javascript.mjs";

const engine: Engine = {
  language: javascriptRuntime.id,
  engineName: javascriptRuntime.engine,
  build: build.sha256,
  limits: javascriptRuntime.limits,
  run: (payload) => runJavaScript(wasm, payload),
  sessions: {
    boot: (options) => createJavaScriptSession(wasm, options),
    restore: (options, snapshot) => restoreJavaScriptSession(wasm, { ...options, snapshot }),
  },
};

const { Worker, Interpreter } = defineInterpreterRuntime(engine);
export { Interpreter };
export default Worker;
