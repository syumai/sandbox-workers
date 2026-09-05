import wasm from "./engine.wasm";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import { runJavaScript, createJavaScriptSession } from "../../../runtime/javascript.mjs";
import { createSessionClass } from "../../../runtime/session.mjs";
import { ApiError, errorResponse, readExecution } from "@sandbox-workers/core";

const ENGINE_NAME = "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6";

export const SandboxSession = createSessionClass({
  language: "javascript",
  engineName: ENGINE_NAME,
  boot(workspace: unknown, cwd: string, onCwdChange: (cwd: string) => void) {
    return createJavaScriptSession(wasm, { workspace, cwd, onCwdChange });
  },
});

interface Env {
  SESSIONS: DurableObjectNamespace;
}

const SESSION_ROUTE = /^\/sessions\/([^/]+)(\/.*)?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sessionMatch = SESSION_ROUTE.exec(url.pathname);
    if (sessionMatch) {
      const [, id, subpath] = sessionMatch;
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id))
        return errorResponse(new ApiError(400, "Invalid session id"));
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
      const headers = new Headers(request.headers);
      headers.set("x-sandbox-session-id", id);
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
      const payload = await readExecution(request, "javascript");
      if (payload.language !== "javascript")
        throw new ApiError(400, "Unsupported language");
      const start = performance.now();
      try {
        const result = runJavaScript(wasm, payload);
        return Response.json(
          {
            code: payload.code,
            language: "javascript",
            engine: "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6",
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
            language: "javascript",
            engine: "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6",
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
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;
