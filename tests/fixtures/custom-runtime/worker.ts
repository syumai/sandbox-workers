// Caller Worker for tests/custom-runtime.mjs: a third-party consumer of a
// runtime Worker built on @sandbox-workers/interpreter (runtime.ts, a
// stateless-only "calc" engine -- see packages/interpreter/README.md's
// "Quick start") through @sandbox-workers/core, over a plain Service
// Binding (CALC). Exercises the free `runCode`, envVars flowing through to
// the engine, a guest error surfacing as `result.error`, and -- through
// this Worker's own `Sandbox` Durable Object -- the stateless fallback for
// a `contexts: false` binding (`createCodeContext` rejects it,
// `sandbox.interpreter.runCode({ binding })` still runs it statelessly).
import { getSandbox, runCode, ValidationFailedError } from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

interface Env {
  Sandbox: DurableObjectNamespace;
  CALC: Fetcher;
}

async function runScenario(env: Env) {
  // Free runCode() against the Service Binding directly.
  const r1 = await runCode(env.CALC, "1 + 2 * 3");

  // envVars flow through to env.NAME lookups in the guest program.
  const r2 = await runCode(env.CALC, "env.X + 1", { envVars: { X: "41" } });

  // A guest error (division by zero) surfaces in result.error rather than
  // throwing.
  const r3 = await runCode(env.CALC, "1 / 0");

  // GET /interpreter, bypassing the typed client: reports protocol: 1 and
  // contexts: false (no `sessions` on this engine).
  const interpreterInfoResponse = await env.CALC.fetch(new Request("https://calc.internal/interpreter"));
  const interpreterInfo = (await interpreterInfoResponse.json()) as {
    language: string;
    engine: string;
    contexts: boolean;
    protocol: number;
  };

  // Through this Worker's own Sandbox Durable Object: createCodeContext
  // fails for a contexts: false binding ...
  const sandbox = getSandbox(env.Sandbox, "custom-runtime-demo");
  let createContextRejected: { isValidationFailedError: boolean; message: string } | undefined;
  try {
    await sandbox.interpreter.createCodeContext({ binding: "CALC" });
  } catch (error) {
    createContextRejected = {
      isValidationFailedError: error instanceof ValidationFailedError,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // ... but runCode({ binding }) still works, falling back to the same
  // stateless path @sandbox-workers/ruby uses -- and the result has no
  // `context` field (see packages/core/src/protocol.ts's ExecutionResult).
  const r4 = await sandbox.interpreter.runCode("6 * 7", { binding: "CALC" });

  return {
    r1: { results: r1.results, error: r1.error },
    r2: { results: r2.results, error: r2.error },
    r3: { results: r3.results, error: r3.error && { name: r3.error.name } },
    interpreterInfo,
    createContextRejected,
    r4: { results: r4.results, hasContext: r4.context !== undefined },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const summary = await runScenario(env);
      return Response.json(summary);
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
