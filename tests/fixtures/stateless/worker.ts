// Caller Worker for tests/stateless.mjs: exercises the free `runCode`
// function (@sandbox-workers/core) against a runtime Worker
// (sandbox-stateless-fixture-engine) deployed WITHOUT an INTERPRETER
// Durable Object binding, over a plain Service Binding (SANDBOX_SERVICE).
// See docs/sandbox-1-0-design.md, "Ruby" / stateless deployments.
import { runCode } from "@sandbox-workers/core";

interface Env {
  SANDBOX_SERVICE: Fetcher;
}

async function runScenario(env: Env) {
  const stdouts: string[] = [];
  const resultFormats: string[][] = [];

  const r1 = await runCode(
    env.SANDBOX_SERVICE,
    "console.log(process.env.X);\nNumber(process.env.X) ** 2",
    {
      envVars: { X: "12" },
      onStdout: (o) => {
        stdouts.push(o.text);
      },
      onResult: (r) => {
        resultFormats.push(r.formats());
      },
    },
  );

  // The runtime's own plain POST /execute still accepts an optional
  // `language` key (validated against its own runtime, aliases accepted) --
  // that's independent of the typed client, which has no `language` option
  // any more (see docs/sandbox-1-0-design.md, "Typed client"). Exercised
  // here with a raw fetch, bypassing runCode().
  const tsResponse = await env.SANDBOX_SERVICE.fetch(
    new Request("https://sandbox.internal/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "const n: number = 1;\nn + 1", language: "ts" }),
    }),
  );
  const tsBody = (await tsResponse.json()) as { results: unknown };

  // "python" is rejected: this runtime only ever executes javascript/typescript.
  const pythonResponse = await env.SANDBOX_SERVICE.fetch(
    new Request("https://sandbox.internal/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "1", language: "python" }),
    }),
  );
  const pythonBody = (await pythonResponse.json()) as { code: string };

  // A guest error surfaces in result.error rather than throwing.
  const guestError = await runCode(env.SANDBOX_SERVICE, "return (;");

  // Direct Service Binding fetch, bypassing the typed client: this Worker
  // has no INTERPRETER Durable Object binding, so GET /interpreter reports
  // contexts: false and every /interpreters/* route answers 400.
  const interpreterInfoResponse = await env.SANDBOX_SERVICE.fetch(
    new Request("https://sandbox.internal/interpreter"),
  );
  const interpreterInfo = (await interpreterInfoResponse.json()) as {
    language: string;
    engine: string;
    contexts: boolean;
  };

  const contextsResponse = await env.SANDBOX_SERVICE.fetch(
    new Request("https://sandbox.internal/interpreters/x/contexts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "c1", cwd: "/workspace" }),
    }),
  );
  const contextsBody = (await contextsResponse.json()) as { message: string };

  return {
    r1: { results: r1.results, stdouts },
    resultFormats,
    ts: { status: tsResponse.status, results: tsBody.results },
    pythonRejected: { status: pythonResponse.status, code: pythonBody.code },
    guestError: { errorName: guestError.error?.name, results: guestError.results },
    interpreterInfo,
    contexts: { status: contextsResponse.status, message: contextsBody.message },
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
