import { pythonRuntime } from "@sandbox-workers/python/metadata";
import { perlRuntime } from "@sandbox-workers/perl/metadata";
import { rubyRuntime } from "@sandbox-workers/ruby/metadata";
import { javascriptRuntime } from "@sandbox-workers/javascript/metadata";
import {
  ApiError,
  errorResponse,
  readExecution,
  type LanguageEngine,
} from "@sandbox-workers/core";
interface Env {
  JAVASCRIPT: Fetcher;
  PYTHON: Fetcher;
  PERL: Fetcher;
  RUBY: Fetcher;
  ASSETS: Fetcher;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/languages" && request.method === "GET")
      return Response.json({
        languages: [javascriptRuntime, pythonRuntime, perlRuntime, rubyRuntime],
      });
    if (path === "/execute") {
      if (request.method !== "POST")
        return Response.json(
          { error: "Use POST" },
          { status: 405, headers: { Allow: "POST" } },
        );
      try {
        const payload = await readExecution(request);
        // Each runtime is deployed as a private, independently versioned Worker.
        const engines: Record<string, LanguageEngine> = Object.create(null);
        engines.javascript = env.JAVASCRIPT;
        engines.python = env.PYTHON;
        engines.perl = env.PERL;
        engines.ruby = env.RUBY;
        const engine = engines[payload.language];
        if (!engine)
          throw new ApiError(400, `Unsupported language: ${payload.language}`);
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
      return new Response("Method not allowed", { status: 405 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
