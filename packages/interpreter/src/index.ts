// @sandbox-workers/interpreter: build your own sandbox-workers runtime
// Worker. See README.md for the Engine contract and a worked example, and
// tmp/interpreter-core-split-design.md for the design this package
// implements.
import type { Engine } from "./engine.js";
import { InterpreterDurableObject } from "./durable-object.js";
import { InterpreterWorker, type InterpreterWorkerEnv } from "./worker.js";
import type { InterpreterEnv } from "./server.js";

export {
  InterpreterWorker,
  type InterpreterWorkerEnv,
} from "./worker.js";
export {
  InterpreterDurableObject,
} from "./durable-object.js";
export { InterpreterServer, type InterpreterEnv } from "./server.js";
export { executionEnvelope, engineErrorOutcome } from "./envelope.js";
export type {
  Engine,
  EngineLimits,
  EngineOutcome,
  SessionOutcome,
  SessionOptions,
  SessionSnapshotSource,
  SessionInstance,
} from "./engine.js";

// Selective re-exports from @sandbox-workers/core an engine author needs,
// so most Engine implementations never have to depend on core directly
// (tmp/interpreter-core-split-design.md section 7.1). Deliberately NOT a
// blanket `export *` -- the caller-side Sandbox/client surface must not leak
// into this package.
export {
  ExecutionLimitError,
  ApiError,
  Workspace,
  WorkspaceError,
  INTERPRETER_PROTOCOL_VERSION,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionLog,
  type ExecutionError,
  type ExecutionUsage,
  type JsonValue,
  type InterpreterInfo,
  type InterpreterExecuteArgs,
  type InterpreterExecuteRpcResult,
  type GetWorkspaceFiles,
  type DurableObjectStateLike,
} from "@sandbox-workers/core";

/**
 * Builds a runtime Worker's two exports from an `Engine`: the default
 * export (`Worker`, a concrete `InterpreterWorker`) and the `Interpreter`
 * Durable Object class (a concrete `InterpreterDurableObject`), both with
 * `engine` wired to the value given here.
 *
 * This is the entry point third-party runtimes -- and this repo's own four
 * language packages -- are meant to use; see README.md. Extending
 * `InterpreterWorker`/`InterpreterDurableObject` directly is for the rarer
 * case of adding custom methods to the Durable Object or Worker
 * entrypoint -- when doing that, do not read `engine` from the
 * constructor: `InterpreterDurableObject`'s constructor builds its
 * `InterpreterServer` before a subclass field initializer has run (see
 * `durable-object.ts`'s doc comment).
 */
export function defineInterpreterRuntime(engine: Engine): {
  Worker: new (ctx: ExecutionContext, env: InterpreterWorkerEnv) => InterpreterWorker;
  Interpreter: new (ctx: DurableObjectState, env: InterpreterEnv) => InterpreterDurableObject;
} {
  class Worker extends InterpreterWorker {
    protected readonly engine = engine;
  }
  class Interpreter extends InterpreterDurableObject {
    protected readonly engine = engine;
  }
  return { Worker, Interpreter };
}
