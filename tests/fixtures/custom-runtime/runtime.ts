// A minimal third-party runtime Worker built entirely on
// @sandbox-workers/interpreter, consumed the way a third party would --
// see packages/interpreter/README.md's "Quick start", which this fixture
// mirrors almost verbatim. Stateless-only: no `sessions`, no `Interpreter`
// Durable Object export, matching this repo's own @sandbox-workers/ruby.
// Used by tests/custom-runtime.mjs via worker.ts (the caller).
import { defineInterpreterRuntime, type Engine } from "@sandbox-workers/interpreter";
import { calc, CalcError } from "./calc.js";

const engine: Engine = {
  language: "calc",
  engineName: "calc fixture 1.0",
  build: "calc-fixture-1", // identifies this build; see the README's "The Engine contract"
  limits: { fuel: 0, memoryBytes: 0, codeBytes: 65536, requestBytes: 98304 },
  run(payload) {
    try {
      const value = calc(payload.code, payload.envVars ?? {});
      return { logs: { stdout: [], stderr: [] }, results: [{ text: String(value) }] };
    } catch (error) {
      // Never throw for a guest-level error -- return it as outcome.error
      // instead (see the README's "The Engine contract").
      if (error instanceof CalcError) {
        return {
          logs: { stdout: [], stderr: [] },
          results: [],
          error: { name: error.name, message: error.message, traceback: [] },
        };
      }
      throw error;
    }
  },
  // No `sessions`: this fixture is stateless-only.
};

export default defineInterpreterRuntime(engine).Worker;
