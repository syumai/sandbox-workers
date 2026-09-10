import wasm from "./engine.wasm";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import { runRuby } from "../../../runtime/ruby.mjs";
import {
  ApiError,
  errorResponse,
  INTERPRETER_PROTOCOL_VERSION,
  readExecution,
} from "@sandbox-workers/core";

const ENGINE_NAME = "CRuby 4.0.0 / ruby.wasm 2.10.1";
const NO_CONTEXTS = "Code contexts are not supported for ruby";

const INTERPRETER_ROUTE = /^\/interpreters\/([^/]+)(\/.*)?$/;

async function handleExecute(request: Request): Promise<Response> {
  const payload = await readExecution(request, { runtimeLanguage: "ruby" });
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
    if (url.pathname === "/interpreter") {
      return Response.json(
        { language: "ruby", engine: ENGINE_NAME, contexts: false, protocol: INTERPRETER_PROTOCOL_VERSION },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (INTERPRETER_ROUTE.test(url.pathname)) {
      return errorResponse(new ApiError(400, NO_CONTEXTS));
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
