import wasm from "./engine.wasm";
import build from "./engine-build.json";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import archive from "./stdlib.bin";
import {
  runEmbedded,
  createEmbeddedSession,
  restoreEmbeddedSession,
} from "../../../runtime/embedded.mjs";
import { createInterpreterClass } from "../../../runtime/interpreter.mjs";
import { ApiError, errorResponse, readExecution } from "@sandbox-workers/core";

const ENGINE_NAME = "Perl 5.42.2 / goccy v0.2.1";
// Message for an /interpreters/:key/* route this Worker can't serve when it
// has no INTERPRETER Durable Object binding (see docs/sandbox-1-0-design.md,
// "Ruby" / stateless deployments).
const NO_INTERPRETER_BINDING =
  "Code contexts are not supported: this Worker has no INTERPRETER Durable Object binding";
const INTERPRETER_KEY = /^[A-Za-z0-9._-]{1,128}$/;

export const Interpreter = createInterpreterClass({
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

// INTERPRETER is optional: a Worker deployed without it (see the CLI's
// --stateless flag and docs/sandbox-1-0-design.md) still serves plain
// /execute; GET /interpreter reports { contexts: false }.
interface Env {
  INTERPRETER?: DurableObjectNamespace;
}

const INTERPRETER_ROUTE = /^\/interpreters\/([^/]+)(\/.*)?$/;

async function handleExecute(request: Request): Promise<Response> {
  const payload = await readExecution(request, { runtimeLanguage: "perl" });
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
    if (url.pathname === "/interpreter") {
      return Response.json(
        { language: "perl", engine: ENGINE_NAME, contexts: !!env.INTERPRETER },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const interpreterMatch = INTERPRETER_ROUTE.exec(url.pathname);
    if (interpreterMatch) {
      const [, key, subpath] = interpreterMatch;
      if (!INTERPRETER_KEY.test(key)) {
        return errorResponse(new ApiError(400, "Invalid interpreter key"));
      }
      if (!env.INTERPRETER) {
        return errorResponse(new ApiError(400, NO_INTERPRETER_BINDING));
      }
      const stub = env.INTERPRETER.get(env.INTERPRETER.idFromName(key));
      const headers = new Headers(request.headers);
      headers.set("x-interpreter-key", key);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const forwarded = new Request(new URL(subpath || "/", url), {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
      });
      return stub.fetch(forwarded);
    }
    if (url.pathname !== "/execute")
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
