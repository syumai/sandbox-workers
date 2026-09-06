import wasm from "./engine.wasm";
import build from "./engine-build.json";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import archive from "./stdlib.bin";
import {
  runEmbedded,
  createEmbeddedSession,
  restoreEmbeddedSession,
} from "../../../runtime/embedded.mjs";
import { createSandboxClass } from "../../../runtime/sandbox.mjs";
import {
  ApiError,
  errorResponse,
  handleStatelessSandboxRoute,
  readExecution,
  validateSandboxId,
} from "@sandbox-workers/core";

const ENGINE_NAME = "Perl 5.42.2 / goccy v0.2.1";
// Message for a /sandboxes/:id/* route this Worker can't serve when it has
// no SANDBOX Durable Object binding (see docs/sdk-parity-design.md,
// "Stateless mode"). A context-less /sandboxes/:id/execute still works.
const NO_SANDBOX_BINDING =
  "Code contexts are not supported: this Worker has no SANDBOX Durable Object binding";

export const Sandbox = createSandboxClass({
  language: "perl",
  engineName: ENGINE_NAME,
  build: build.sha256,
  boot(workspace: unknown, cwd: string) {
    return createEmbeddedSession(wasm, archive, "perl", { workspace, cwd });
  },
  restore(workspace: unknown, cwd: string, _onCwdChange: unknown, snapshot: unknown) {
    return restoreEmbeddedSession(wasm, archive, "perl", { workspace, cwd, snapshot });
  },
});

// SANDBOX is optional: a Worker deployed without it (see the CLI's
// --stateless flag and docs/sdk-parity-design.md, "Stateless mode") still
// serves plain /execute and a context-less /sandboxes/:id/execute.
interface Env {
  SANDBOX?: DurableObjectNamespace;
}

const SANDBOX_ROUTE = /^\/sandboxes\/([^/]+)(\/.*)?$/;

async function handleExecute(
  request: Request,
  options?: { rejectContextId?: string },
): Promise<Response> {
  const payload = await readExecution(request, {
    runtimeLanguage: "perl",
    ...options,
  });
  const start = performance.now();
  try {
    const result = runEmbedded(wasm, archive, "perl", payload);
    return Response.json(
      {
        code: payload.code,
        language: "perl",
        engine: ENGINE_NAME,
        durationMs: performance.now() - start,
        ...result,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const limited = error instanceof ExecutionLimitError;
    return Response.json(
      {
        code: payload.code,
        language: "perl",
        engine: ENGINE_NAME,
        durationMs: performance.now() - start,
        logs: { stdout: [], stderr: [] },
        results: [],
        error: {
          name: limited ? "ExecutionLimitError" : "EngineError",
          message:
            error instanceof Error
              ? error.message.slice(0, 2048)
              : "Execution failed",
          traceback: [],
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandboxMatch = SANDBOX_ROUTE.exec(url.pathname);
    if (sandboxMatch) {
      const [, id, subpath] = sandboxMatch;
      try {
        validateSandboxId(id);
      } catch (error) {
        return errorResponse(
          new ApiError(400, error instanceof Error ? error.message : "Invalid sandbox id"),
        );
      }
      if (!env.SANDBOX) {
        return handleStatelessSandboxRoute(request, subpath, {
          reason: NO_SANDBOX_BINDING,
          execute: (req) => handleExecute(req, { rejectContextId: NO_SANDBOX_BINDING }),
        });
      }
      const stub = env.SANDBOX.get(env.SANDBOX.idFromName(id));
      const headers = new Headers(request.headers);
      headers.set("x-sandbox-id", id);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const forwarded = new Request(new URL(subpath || "/", url), {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
      });
      return stub.fetch(forwarded);
    }
    if (new URL(request.url).pathname !== "/execute")
      return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    try {
      return await handleExecute(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
