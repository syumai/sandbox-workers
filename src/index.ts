import { pythonRuntime } from "@sandbox-workers/python/metadata";
import { perlRuntime } from "@sandbox-workers/perl/metadata";
import { rubyRuntime } from "@sandbox-workers/ruby/metadata";
import { javascriptRuntime } from "@sandbox-workers/javascript/metadata";
import {
  ApiError,
  errorResponse,
  readBody,
  readExecution,
  MAX_REQUEST_BYTES,
  MAX_FILES_REQUEST_BYTES,
  type LanguageEngine,
} from "@sandbox-workers/core";
interface Env {
  JAVASCRIPT: Fetcher;
  PYTHON: Fetcher;
  PERL: Fetcher;
  RUBY: Fetcher;
  ASSETS: Fetcher;
}
// Each runtime is deployed as a private, independently versioned Worker.
function engineFor(env: Env, language: string): LanguageEngine | undefined {
  const engines: Record<string, LanguageEngine> = Object.create(null);
  engines.javascript = env.JAVASCRIPT;
  engines.python = env.PYTHON;
  engines.perl = env.PERL;
  engines.ruby = env.RUBY;
  return engines[language];
}
const SANDBOX_ROUTE = /^\/languages\/([^/]+)(\/sandboxes\/.+)$/;
const SANDBOX_METHODS = new Set(["GET", "POST", "DELETE"]);
// Builds a 405 error response in the ErrorResponse shape, with an Allow
// header attached (errorResponse() itself doesn't set one).
function methodNotAllowed(message: string, allow: string): Response {
  const res = errorResponse(new ApiError(405, message));
  return new Response(res.body, {
    status: res.status,
    headers: { ...Object.fromEntries(res.headers), Allow: allow },
  });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/languages" && request.method === "GET")
      return Response.json({
        languages: [javascriptRuntime, pythonRuntime, perlRuntime, rubyRuntime],
      });
    if (path === "/execute" || path.startsWith("/execute/")) {
      if (request.method !== "POST")
        return methodNotAllowed("Use POST", "POST");
      try {
        // The Playground gateway selects a runtime from the URL path; each
        // runtime is deployed as a private, independently versioned Worker.
        const id = path === "/execute" ? "javascript" : path.slice("/execute/".length);
        const engine = engineFor(env, id);
        if (!engine) throw new ApiError(400, `Unsupported language: ${id}`);
        const payload = await readExecution(request);
        return await engine.fetch(
          new Request("https://engine.internal/execute", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (path === "/languages")
      return methodNotAllowed("Method not allowed", "GET");
    // Forward /languages/:language/sandboxes/:id[/...] to the runtime binding
    // for :language as /sandboxes/:id[/...]. Bodies are passed through
    // unchanged (size-limited like /execute); status codes and bodies are
    // relayed verbatim.
    const sandboxMatch = SANDBOX_ROUTE.exec(path);
    if (sandboxMatch) {
      const [, language, rest] = sandboxMatch;
      if (!SANDBOX_METHODS.has(request.method))
        return methodNotAllowed("Method not allowed", "GET, POST, DELETE");
      try {
        const engine = engineFor(env, language);
        if (!engine)
          throw new ApiError(400, `Unsupported language: ${language}`);
        const init: RequestInit = { method: request.method };
        if (request.method === "POST") {
          init.body = await readBody(
            request,
            rest.endsWith("/files")
              ? MAX_FILES_REQUEST_BYTES
              : MAX_REQUEST_BYTES,
          );
          init.headers = {
            "content-type":
              request.headers.get("content-type") ?? "application/json",
          };
        }
        return await engine.fetch(
          new Request(`https://engine.internal${rest}`, init),
        );
      } catch (error) {
        return errorResponse(error);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
