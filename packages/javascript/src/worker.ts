import wasm from "./engine.wasm";
import build from "./engine-build.json";
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { javascriptRuntime } from "./metadata.js";
import {
  runJavaScript,
  createJavaScriptSession,
  restoreJavaScriptSession,
} from "./engine.mjs";

const engine: Engine = {
  language: javascriptRuntime.id,
  engineName: javascriptRuntime.engine,
  build: build.sha256,
  limits: javascriptRuntime.limits,
  run: (payload) => runJavaScript(wasm, payload, javascriptRuntime.limits),
  sessions: {
    boot: (options) => createJavaScriptSession(wasm, options, javascriptRuntime.limits),
    restore: (options, snapshot) => restoreJavaScriptSession(wasm, options, snapshot, javascriptRuntime.limits),
  },
};

const { Worker, Interpreter } = defineInterpreterRuntime(engine);
export { Interpreter };
export default Worker;
