import { pythonRuntime } from "@sandbox-workers/python/metadata";
import { perlRuntime } from "@sandbox-workers/perl/metadata";
import { rubyRuntime } from "@sandbox-workers/ruby/metadata";
import { javascriptRuntime } from "@sandbox-workers/javascript/metadata";
import {
  ApiError,
  errorResponse,
  readBody,
  readExecution,
  validateSandboxId,
  MAX_REQUEST_BYTES,
  MAX_FILES_REQUEST_BYTES,
  type LanguageEngine,
} from "@sandbox-workers/core";
// The gateway is an ordinary caller of @sandbox-workers/core: it re-exports
// the Sandbox Durable Object class below (see wrangler.jsonc's
// durable_objects binding and v1 migration) and forwards
// /languages/:language/sandboxes/:id[/...] to its own Sandbox, one per
// (language, id) pair -- see docs/sandbox-1-0-design.md, "Gateway
// (Playground) and UI".
export { Sandbox } from "@sandbox-workers/core";
interface Env {
  JAVASCRIPT: Fetcher;
  PYTHON: Fetcher;
  PERL: Fetcher;
  RUBY: Fetcher;
  ASSETS: Fetcher;
  Sandbox: DurableObjectNamespace;
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
// The gateway's own Service Binding names double as the four supported
// runtimes: :language in /languages/:language/sandboxes/:id becomes
// binding = :language.toUpperCase() for the caller-hosted Sandbox
// (docs/sandbox-1-0-design.md, "Gateway (Playground) and UI").
const RUNTIMES = new Set(["javascript", "python", "perl", "ruby"]);
const SANDBOX_ROUTE = /^\/languages\/([^/]+)\/sandboxes\/([^/]+)((?:\/.*)?)$/;
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
        // id is validated above against the four supported runtimes, so it
        // doubles as the runtimeLanguage a language key in the body is
        // checked against (see packages/core/src/protocol.ts, readExecution).
        const payload = await readExecution(request, { runtimeLanguage: id });
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
    // Forward /languages/:language/sandboxes/:id[/...] to the gateway's own
    // Sandbox Durable Object (keyed by :id), with :language.toUpperCase()
    // forced as `binding` on POST .../contexts and POST .../execute -- the
    // gateway's Service Binding names are JAVASCRIPT/PYTHON/PERL/RUBY, so
    // the same sandbox id reached through two languages is one sandbox with
    // two bindings (docs/sandbox-1-0-design.md). Every other sub-path is
    // forwarded unchanged.
    const sandboxMatch = SANDBOX_ROUTE.exec(path);
    if (sandboxMatch) {
      const [, language, id, rest] = sandboxMatch;
      if (!SANDBOX_METHODS.has(request.method))
        return methodNotAllowed("Method not allowed", "GET, POST, DELETE");
      try {
        if (!RUNTIMES.has(language))
          throw new ApiError(400, `Unsupported language: ${language}`);
        try {
          validateSandboxId(id);
        } catch (error) {
          throw new ApiError(400, error instanceof Error ? error.message : "Invalid sandbox id");
        }
        const binding = language.toUpperCase();
        const subpath = rest || "/";
        const init: RequestInit = { method: request.method };
        const headers: Record<string, string> = { "x-sandbox-id": id };
        if (request.method === "POST") {
          const maxBytes = subpath === "/files" ? MAX_FILES_REQUEST_BYTES : MAX_REQUEST_BYTES;
          if (subpath === "/contexts" || subpath === "/execute") {
            const bytes = await readBody(request, maxBytes);
            let parsed: unknown;
            try {
              parsed = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              throw new ApiError(400, "Invalid JSON");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new ApiError(400, "Expected an object");
            (parsed as Record<string, unknown>).binding = binding;
            init.body = JSON.stringify(parsed);
          } else {
            init.body = await readBody(request, maxBytes);
          }
          headers["content-type"] =
            request.headers.get("content-type") ?? "application/json";
        }
        init.headers = headers;
        const stub = env.Sandbox.get(env.Sandbox.idFromName(id));
        return await stub.fetch(new Request(`https://sandbox.internal${subpath}`, init));
      } catch (error) {
        return errorResponse(error);
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
