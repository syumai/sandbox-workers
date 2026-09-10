// The stateless success/failure envelope shared by every runtime Worker's
// `POST /execute`, factored out of what used to be duplicated in each
// worker.ts's `handleExecute` catch and in the pre-split, now-deleted interpreter.mjs's `_run`'s
// catch (tmp/interpreter-core-split-design.md section 3).

import { ExecutionLimitError, type ExecutionResult } from "@sandbox-workers/core";
import type { Engine, EngineOutcome } from "./engine.js";

/**
 * Builds the stateless `/execute` response body (`ExecutionResult`) from an
 * engine's outcome: adds the fields every runtime Worker reports beyond
 * `EngineOutcome` itself (`code`, `language`, `engine`, `durationMs`). Used
 * by `InterpreterWorker.fetch`'s `POST /execute` route.
 */
export function executionEnvelope(
  engine: Pick<Engine, "language" | "engineName">,
  code: string,
  startMs: number,
  outcome: EngineOutcome,
): ExecutionResult {
  return {
    code,
    language: engine.language,
    engine: engine.engineName,
    durationMs: performance.now() - startMs,
    ...outcome,
  };
}

/**
 * Turns a thrown error from `Engine.run`/`SessionInstance.execute`'s
 * host-bug path into an `EngineOutcome` with empty logs/results:
 * `ExecutionLimitError` maps to `{ name: "ExecutionLimitError" }`, anything
 * else to a generic `EngineError`. The message is sliced to 2048 characters,
 * matching every pre-split worker.ts's `handleExecute` catch and the
 * pre-split, now-deleted interpreter.mjs's `_run`'s catch.
 */
export function engineErrorOutcome(error: unknown): EngineOutcome {
  const limited = error instanceof ExecutionLimitError;
  const message =
    error instanceof Error ? error.message : String(error ?? "Execution failed");
  return {
    logs: { stdout: [], stderr: [] },
    results: [],
    error: {
      name: limited ? "ExecutionLimitError" : "EngineError",
      message: message.slice(0, 2048),
      traceback: [],
    },
  };
}
