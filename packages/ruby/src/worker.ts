import wasm from "./engine.wasm";
import build from "./engine-build.json";
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { rubyRuntime } from "./metadata.js";
import { runRuby } from "../../../runtime/ruby.mjs";

// No `sessions`: code contexts are not supported for ruby (see
// runtime/ruby.mjs). `defineInterpreterRuntime` still returns an
// `Interpreter` class, but it's not exported here -- an engine with no
// `sessions` never gets its Durable Object bound in wrangler config, and
// `InterpreterWorker`/`InterpreterServer` already answer 400 for every
// `/interpreters/*` route and the `executeInContext` RPC call when
// `engine.sessions` is undefined.
const engine: Engine = {
  language: rubyRuntime.id,
  engineName: rubyRuntime.engine,
  build: build.sha256,
  limits: rubyRuntime.limits,
  run: (payload) => runRuby(wasm, payload),
};

export default defineInterpreterRuntime(engine).Worker;
