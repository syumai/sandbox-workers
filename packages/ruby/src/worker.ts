import wasm from "./engine.wasm";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import { runRuby } from "../../../runtime/ruby.mjs";
import { ApiError, errorResponse, readExecution } from "@sandbox-workers/core";

const ENGINE_NAME = "CRuby 4.0.0 / ruby.wasm 2.10.1";
const NO_CONTEXTS = "Code contexts are not supported for ruby";

const SANDBOX_ROUTE = /^\/sandboxes\/([^/]+)(\/.*)?$/;

async function handleExecute(request: Request): Promise<Response> {
  const payload = await readExecution(request);
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

// A context-less POST /sandboxes/:id/execute runs statelessly, the same as
// plain /execute (see docs/sdk-parity-design.md, "Ruby"). readExecution()
// only knows about `input`/`language` as reserved keys, so `contextId` and
// `language` are validated here first and stripped before delegating to it:
// a `contextId` means the caller wants a durable code context (not
// supported), and a `language` other than "ruby" is meaningless on this
// runtime -- both answer the same 400.
async function readRubySandboxExecution(request: Request): Promise<Request> {
  const contentType = request.headers.get("content-type") ?? undefined;
  const text = await request.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Malformed JSON: let readExecution's own parser produce the "Invalid
    // JSON" error by handing the original text straight through.
    return new Request(request.url, {
      method: request.method,
      headers: contentType ? { "content-type": contentType } : {},
      body: text,
    });
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const body = parsed as Record<string, unknown>;
    if ("contextId" in body) throw new ApiError(400, NO_CONTEXTS);
    if ("language" in body) {
      if (body.language !== "ruby") throw new ApiError(400, NO_CONTEXTS);
      delete body.language;
    }
    return new Request(request.url, {
      method: request.method,
      headers: contentType ? { "content-type": contentType } : {},
      body: JSON.stringify(body),
    });
  }
  return new Request(request.url, {
    method: request.method,
    headers: contentType ? { "content-type": contentType } : {},
    body: text,
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sandboxMatch = SANDBOX_ROUTE.exec(url.pathname);
    if (sandboxMatch) {
      const [, id, subpath] = sandboxMatch;
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id))
        return errorResponse(new ApiError(400, "Invalid sandbox id"));
      // Every /sandboxes/* route other than a context-less execute is
      // unsupported for ruby: no Durable Object backs it.
      if (request.method !== "POST" || (subpath ?? "/") !== "/execute")
        return errorResponse(new ApiError(400, NO_CONTEXTS));
      try {
        const filtered = await readRubySandboxExecution(request);
        return await handleExecute(filtered);
      } catch (error) {
        return errorResponse(error);
      }
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
