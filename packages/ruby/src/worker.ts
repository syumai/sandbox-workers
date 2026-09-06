import wasm from "./engine.wasm";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import { runRuby } from "../../../runtime/ruby.mjs";
import {
  ApiError,
  errorResponse,
  handleStatelessSandboxRoute,
  readExecution,
  validateSandboxId,
} from "@sandbox-workers/core";

const ENGINE_NAME = "CRuby 4.0.0 / ruby.wasm 2.10.1";
const NO_CONTEXTS = "Code contexts are not supported for ruby";

const SANDBOX_ROUTE = /^\/sandboxes\/([^/]+)(\/.*)?$/;

// A context-less POST /sandboxes/:id/execute runs statelessly, the same as
// plain /execute (see docs/sdk-parity-design.md, "Ruby"); a `contextId` in
// the body means the caller wants a durable code context, which isn't
// supported, and neither is any other method/sub-path.
async function handleExecute(
  request: Request,
  options?: { rejectContextId?: string },
): Promise<Response> {
  const payload = await readExecution(request, {
    runtimeLanguage: "ruby",
    ...options,
  });
  const start = performance.now();
  try {
    const result = await runRuby(wasm, payload);
    return Response.json(
      {
        code: payload.code,
        language: "ruby",
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
        language: "ruby",
        engine: ENGINE_NAME,
        durationMs: performance.now() - start,
        logs: { stdout: [], stderr: [] },
        results: [],
        error: {
          name: limited ? "ExecutionLimitError" : "EngineError",
          message:
            error instanceof Error ? error.message.slice(0, 2048) : "Execution failed",
          traceback: [],
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
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
      // Every /sandboxes/* route other than a context-less execute is
      // unsupported for ruby: no Durable Object backs it.
      return handleStatelessSandboxRoute(request, subpath, {
        reason: NO_CONTEXTS,
        execute: (req) => handleExecute(req, { rejectContextId: NO_CONTEXTS }),
      });
    }
    if (url.pathname !== "/execute") return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    try {
      return await handleExecute(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler;
