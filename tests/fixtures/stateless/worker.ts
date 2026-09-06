// Caller Worker for tests/stateless.mjs: exercises the free `runCode`
// function (@sandbox-workers/core) against a runtime Worker
// (sandbox-stateless-fixture-engine) deployed WITHOUT a SANDBOX Durable
// Object binding, over a plain Service Binding (SANDBOX_SERVICE). See
// docs/sdk-parity-design.md, "Stateless mode".
import { runCode, ValidationFailedError } from "@sandbox-workers/core";

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

  // "ts" is accepted: the javascript runtime also runs TypeScript.
  const ts = await runCode(env.SANDBOX_SERVICE, "const n: number = 1;\nn + 1", {
    language: "ts",
  });

  // "python" is rejected: this runtime only ever executes javascript/typescript.
  let pythonRejected: { name: string; isClass: boolean; code: string } | undefined;
  try {
    await runCode(env.SANDBOX_SERVICE, "1", { language: "python" });
  } catch (e) {
    const error = e as InstanceType<typeof ValidationFailedError>;
    pythonRejected = {
      name: error.name,
      isClass: error instanceof ValidationFailedError,
      code: error.code,
    };
  }

  // A guest error surfaces in result.error rather than throwing.
  const guestError = await runCode(env.SANDBOX_SERVICE, "return (;");

  // Direct Service Binding fetch, bypassing the typed client, exercising the
  // runtime Worker's stateless /sandboxes/:id/* route directly: a
  // context-less execute succeeds, but any other route (here, creating a
  // code context) is rejected -- this Worker has no SANDBOX Durable Object
  // binding to back it.
  const execResponse = await env.SANDBOX_SERVICE.fetch(
    new Request("https://sandbox.internal/sandboxes/x/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "1 + 1" }),
    }),
  );
  const execBody = (await execResponse.json()) as { results: unknown };

  const contextsResponse = await env.SANDBOX_SERVICE.fetch(
    new Request("https://sandbox.internal/sandboxes/x/contexts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  const contextsBody = (await contextsResponse.json()) as { message: string };

  return {
    r1: { results: r1.results, stdouts },
    resultFormats,
    ts: { results: ts.results },
    pythonRejected,
    guestError: { errorName: guestError.error?.name, results: guestError.results },
    exec: { status: execResponse.status, results: execBody.results },
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
