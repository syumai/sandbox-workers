import wasm from "./engine.wasm";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import { runRuby } from "../../../runtime/ruby.mjs";
import { ApiError, errorResponse, readExecution } from "@sandbox-workers/core";
export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/execute")
      return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    try {
      const payload = await readExecution(request, "ruby");
      if (payload.language !== "ruby")
        throw new ApiError(400, "Unsupported language");
      const start = performance.now();
      try {
        const result = await runRuby(wasm, payload);
        return Response.json(
          {
            ...result,
            language: "ruby",
            engine: "CRuby 4.0.0 / ruby.wasm 2.10.1",
            durationMs: performance.now() - start,
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        const limited = error instanceof ExecutionLimitError;
        return Response.json(
          {
            ok: false,
            language: "ruby",
            error: {
              name: limited ? "ExecutionLimitError" : "EngineError",
              message:
                error instanceof Error
                  ? error.message.slice(0, 2048)
                  : "Execution failed",
            },
            logs: [],
            durationMs: performance.now() - start,
          },
          {
            status: limited ? 422 : 400,
            headers: { "cache-control": "no-store" },
          },
        );
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler;
