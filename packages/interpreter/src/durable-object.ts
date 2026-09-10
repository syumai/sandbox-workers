// InterpreterDurableObject: the thin `cloudflare:workers` `DurableObject`
// wrapper every runtime Worker's `Interpreter` export extends (directly, or
// via `defineInterpreterRuntime` -- see `index.ts`). All the actual logic
// lives in `InterpreterServer` (`./server.ts`, a plain class, Node-testable
// via `./testing.ts`); this class only wires it to the real
// `DurableObjectState`/RPC surface.
import { DurableObject } from "cloudflare:workers";
import type { InterpreterExecuteArgs, InterpreterExecuteRpcResult, GetWorkspaceFiles } from "@sandbox-workers/core";
import type { Engine } from "./engine.js";
import { InterpreterServer, type InterpreterEnv } from "./server.js";

export abstract class InterpreterDurableObject<
  E extends InterpreterEnv = InterpreterEnv,
> extends DurableObject<E> {
  protected abstract readonly engine: Engine;
  private readonly server: InterpreterServer;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    // `engine` is read lazily (a getter closure, not a value) because the
    // subclass's own `engine` field is not yet initialized while this
    // constructor -- and DurableObject's own, via `super(ctx, env)` -- runs.
    // Nothing InterpreterServer's constructor does (schema setup, via
    // `ctx.blockConcurrencyWhile`) touches the engine; see server.ts's
    // constructor doc comment.
    this.server = new InterpreterServer(ctx, env, () => this.engine);
  }

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request);
  }

  async executeInContext(
    key: string,
    args: InterpreterExecuteArgs,
    getFiles: GetWorkspaceFiles,
  ): Promise<InterpreterExecuteRpcResult> {
    return this.server.executeInContext(key, args, getFiles);
  }

  async alarm(): Promise<void> {
    return this.server.alarm();
  }
}
