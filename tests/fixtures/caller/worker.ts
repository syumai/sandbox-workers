// Caller Worker for tests/caller.mjs: exercises the typed
// @sandbox-workers/core client end to end against two runtime Workers
// (sandbox-engine-javascript bound as JAVASCRIPT, sandbox-engine-python
// bound as PYTHON), driving code contexts in both languages that share one
// sandbox's single /workspace. See docs/sandbox-1-0-design.md, "Model" and
// "Typed client".
import {
  getSandbox,
  ContextNotFoundError,
  ValidationFailedError,
  type SandboxClient,
} from "@sandbox-workers/core";

export { Sandbox } from "@sandbox-workers/core";

interface Env {
  Sandbox: DurableObjectNamespace;
  JAVASCRIPT: Fetcher;
  PYTHON: Fetcher;
}

interface ErrorSummary {
  name: string;
  isClass: boolean;
  code: string;
}

function summarizeError(error: unknown, Class: new (...args: never[]) => Error): ErrorSummary {
  const err = error as Error & { code: string };
  return { name: err.name, isClass: error instanceof Class, code: err.code };
}

async function runScenario(sandbox: SandboxClient) {
  // Two contexts, one per language, sharing /workspace.
  const js = await sandbox.interpreter.createCodeContext({
    binding: "JAVASCRIPT",
    envVars: { CTX: "js" },
  });
  const py = await sandbox.interpreter.createCodeContext({ binding: "PYTHON" });

  await sandbox.setEnvVars({ SB: "s" });

  // JavaScript writes a file with fs.writeFileSync; Python reads it with
  // open() -- proving the two contexts share the sandbox's /workspace even
  // though they don't share globals.
  const write = await sandbox.interpreter.runCode(
    'fs.writeFileSync("/workspace/shared.txt", "from js: " + process.env.SB + "/" + process.env.CTX)',
    { context: js },
  );
  const read = await sandbox.interpreter.runCode('open("/workspace/shared.txt").read()', {
    context: py,
  });

  // Default context per binding: two context-less calls against the same
  // binding resolve to the same (oldest) context -- here, `js` itself.
  const d1 = await sandbox.interpreter.runCode("1 + 1", { binding: "JAVASCRIPT" });
  const d2 = await sandbox.interpreter.runCode("2 + 2", { binding: "JAVASCRIPT" });

  // ContextNotFoundError for a bogus context id.
  let contextNotFound: ErrorSummary | undefined;
  try {
    await sandbox.interpreter.deleteCodeContext("does-not-exist");
  } catch (error) {
    contextNotFound = summarizeError(error, ContextNotFoundError);
  }

  // ValidationFailedError for an unknown binding.
  let unknownBinding: ErrorSummary | undefined;
  try {
    await sandbox.interpreter.createCodeContext({ binding: "UNKNOWN" });
  } catch (error) {
    unknownBinding = summarizeError(error, ValidationFailedError);
  }

  // ValidationFailedError for runCode() without a context or a binding.
  let noTarget: ErrorSummary | undefined;
  try {
    await sandbox.interpreter.runCode("1");
  } catch (error) {
    noTarget = summarizeError(error, ValidationFailedError);
  }

  // setEnvVars layering: the sandbox-level var is visible until unset with
  // `undefined` (wire-encoded as null).
  const envBefore = await sandbox.interpreter.runCode("process.env.SB", { context: js });
  await sandbox.setEnvVars({ SB: undefined });
  const envAfter = await sandbox.interpreter.runCode("process.env.SB ?? 'unset'", { context: js });

  // Files API round trip.
  await sandbox.writeFile("/workspace/api.txt", "hello");
  const readBack = await sandbox.readFile("/workspace/api.txt");
  const listed = await sandbox.listFiles("/workspace");

  const info = await sandbox.getInfo();

  await sandbox.interpreter.deleteCodeContext(js.id);
  await sandbox.interpreter.deleteCodeContext(py.id);
  await sandbox.destroy();
  const infoAfterDestroy = await sandbox.getInfo();

  return {
    write: { results: write.results },
    read: { results: read.results },
    defaultContext: {
      sameAsJs: d1.context?.id === js.id,
      sameAcrossCalls: d1.context?.id === d2.context?.id,
      r1: d1.results,
      r2: d2.results,
    },
    contextNotFound,
    unknownBinding,
    noTarget,
    env: { before: envBefore.results, after: envAfter.results },
    files: {
      content: readBack.content,
      listed: listed.files.map((f) => f.absolutePath),
    },
    info: {
      contextCount: info.contexts.length,
      bindings: info.contexts.map((c) => c.binding).sort(),
    },
    infoAfterDestroy: { contextCount: infoAfterDestroy.contexts.length },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return new Response("id query param required", { status: 400 });
    const sandbox = getSandbox(env.Sandbox, id);
    try {
      const summary = await runScenario(sandbox);
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
