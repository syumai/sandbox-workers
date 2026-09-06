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
import { ApiError, errorResponse, readExecution } from "@sandbox-workers/core";

const ENGINE_NAME = "CPython 3.14.6 / goccy v0.2.0";

export const Sandbox = createSandboxClass({
  language: "python",
  engineName: ENGINE_NAME,
  build: build.sha256,
  boot(workspace: unknown, cwd: string) {
    return createEmbeddedSession(wasm, archive, "python", { workspace, cwd });
  },
  restore(workspace: unknown, cwd: string, _onCwdChange: unknown, snapshot: unknown) {
    return restoreEmbeddedSession(wasm, archive, "python", { workspace, cwd, snapshot });
  },
});

interface Env {
  SANDBOX: DurableObjectNamespace;
}

const SANDBOX_ROUTE = /^\/sandboxes\/([^/]+)(\/.*)?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandboxMatch = SANDBOX_ROUTE.exec(url.pathname);
    if (sandboxMatch) {
      const [, id, subpath] = sandboxMatch;
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id))
        return errorResponse(new ApiError(400, "Invalid sandbox id"));
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
      const payload = await readExecution(request);
      const start = performance.now();
      try {
        const result = runEmbedded(wasm, archive, "python", payload);
        return Response.json(
          {
            code: payload.code,
            language: "python",
            engine: "CPython 3.14.6 / goccy v0.2.0",
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
            language: "python",
            engine: "CPython 3.14.6 / goccy v0.2.0",
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
