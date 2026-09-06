// Caller Worker for tests/do-binding.mjs: exercises the typed
// @sandbox-workers/core client against the same runtime Worker
// (sandbox-engine-javascript) over both supported transports --
// a Durable Object namespace bound with script_name (SANDBOX_DO), and a
// plain Service Binding (SANDBOX_SERVICE) -- to prove getSandbox() behaves
// the same way over each (see docs/sdk-parity-design.md, "Model").
import { getSandbox, FileNotFoundError, type Sandbox } from "@sandbox-workers/core";

interface Env {
  SANDBOX_DO: DurableObjectNamespace;
  SANDBOX_SERVICE: Fetcher;
}

async function runScenario(sandbox: Sandbox) {
  const results: string[][] = [];
  const stdouts: string[] = [];

  const ctx = await sandbox.createCodeContext({ envVars: { CTX: "c" } });
  await sandbox.setEnvVars({ SB: "s" });
  const r1 = await sandbox.runCode(
    "var n = 41; [process.env.SB, process.env.CTX, process.env.CALL]",
    {
      context: ctx,
      envVars: { CALL: "x" },
      onResult: (r) => {
        results.push(r.formats());
      },
      onStdout: (o) => {
        stdouts.push(o.text);
      },
    },
  );
  const r2 = await sandbox.runCode("n + 1", { context: ctx });
  // No context given: resolves to the "default" context for the runtime's
  // language (docs/sdk-parity-design.md, "Default context") -- the first
  // existing context whose language matches, which by now is `ctx` itself
  // (created above), not a fresh one. So this still sees `n`.
  const dflt = await sandbox.runCode("typeof n");

  await sandbox.writeFile("/workspace/a.txt", "hello");
  await sandbox.mkdir("/workspace/dir");
  await sandbox.moveFile("/workspace/a.txt", "/workspace/dir/a.txt");
  const read = await sandbox.readFile("/workspace/dir/a.txt");
  const list = await sandbox.listFiles("/workspace", { recursive: true });
  const ex = await sandbox.exists("/workspace/a.txt");

  let notFound: { name: string; isClass: boolean; code: string; httpStatus: number } | undefined;
  try {
    await sandbox.readFile("/workspace/nope");
  } catch (e) {
    const error = e as InstanceType<typeof FileNotFoundError>;
    notFound = {
      name: error.name,
      isClass: error instanceof FileNotFoundError,
      code: error.code,
      httpStatus: error.httpStatus,
    };
  }

  const contexts = (await sandbox.listCodeContexts()).map((c) => ({
    id: c.id,
    isDate: c.createdAt instanceof Date,
  }));
  const info = await sandbox.getInfo();

  await sandbox.deleteCodeContext(ctx.id);
  await sandbox.destroy();

  return {
    r1: { results: r1.results, executionCount: r1.executionCount, contextId: r1.context?.id },
    r2: { results: r2.results },
    dflt: { results: dflt.results, contextId: dflt.context?.id },
    sameContext: r1.context?.id === ctx.id,
    read: { content: read.content, mimeType: read.mimeType },
    list: list.files.map((f) => f.absolutePath),
    ex: { exists: ex.exists },
    notFound,
    contexts,
    contextsLength: info.contexts.length,
    results,
    stdouts,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const via = url.searchParams.get("via");
    const id = url.searchParams.get("id");
    if (!id) return new Response("id query param required", { status: 400 });
    if (via !== "do" && via !== "service")
      return new Response("via must be 'do' or 'service'", { status: 400 });
    const target = via === "do" ? env.SANDBOX_DO : env.SANDBOX_SERVICE;
    const sandbox = getSandbox(target, id);
    try {
      const summary = await runScenario(sandbox);
      // Diagnostic: how workerd tags the binding object (see isNamespaceTarget
      // in packages/core/src/client.ts).
      return Response.json({ ...summary, targetTag: Object.prototype.toString.call(target) });
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
