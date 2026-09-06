import wasm from "./engine.wasm";
import build from "./engine-build.json";
import { WorkerEntrypoint } from "cloudflare:workers";
import { ExecutionLimitError } from "../../../runtime/wasi.mjs";
import {
  runJavaScript,
  createJavaScriptSession,
  restoreJavaScriptSession,
} from "../../../runtime/javascript.mjs";
import { createInterpreterClass } from "../../../runtime/interpreter.mjs";
import {
  ApiError,
  errorBody,
  errorResponse,
  readExecution,
  type GetWorkspaceFiles,
  type InterpreterExecuteArgs,
  type InterpreterExecuteRpcResult,
} from "@sandbox-workers/core";

const ENGINE_NAME = "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6";
// Message for an /interpreters/:key/* route this Worker can't serve when it
// has no INTERPRETER Durable Object binding (see docs/sandbox-1-0-design.md,
// "Ruby" / stateless deployments).
const NO_INTERPRETER_BINDING =
  "Code contexts are not supported: this Worker has no INTERPRETER Durable Object binding";
const INTERPRETER_KEY = /^[A-Za-z0-9._-]{1,128}$/;

export const Interpreter = createInterpreterClass({
  language: "javascript",
  engineName: ENGINE_NAME,
  build: build.sha256,
  boot(workspace: unknown, cwd: string, onCwdChange: (cwd: string) => void) {
    return createJavaScriptSession(wasm, { workspace, cwd, onCwdChange });
  },
  restore(workspace: unknown, cwd: string, onCwdChange: (cwd: string) => void, snapshot: unknown) {
    return restoreJavaScriptSession(wasm, { workspace, cwd, onCwdChange, snapshot });
  },
});

// INTERPRETER is optional: a Worker deployed without it (see the CLI's
// --stateless flag and docs/sandbox-1-0-design.md) still serves plain
// /execute; GET /interpreter reports { contexts: false }.
interface Env {
  INTERPRETER?: DurableObjectNamespace;
}

// The Interpreter Durable Object stub, as seen for the `executeInContext`
// RPC method: `DurableObjectNamespace.get()` is untyped here (see `Env`
// above), so this is asserted at the one call site that needs it rather than
// threaded through the ambient ~`DurableObjectStub` type.
type InterpreterStub = Fetcher & {
  executeInContext(
    key: string,
    args: InterpreterExecuteArgs,
    getFiles: GetWorkspaceFiles,
  ): Promise<InterpreterExecuteRpcResult>;
};

const INTERPRETER_ROUTE = /^\/interpreters\/([^/]+)(\/.*)?$/;

async function handleExecute(request: Request): Promise<Response> {
  const payload = await readExecution(request, { runtimeLanguage: "javascript" });
  const start = performance.now();
  try {
    const result = runJavaScript(wasm, payload);
    return Response.json(
      {
        code: payload.code,
        language: "javascript",
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
        language: "javascript",
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

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const env = this.env;
    const url = new URL(request.url);
    if (url.pathname === "/interpreter") {
      return Response.json(
        { language: "javascript", engine: ENGINE_NAME, contexts: !!env.INTERPRETER },
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
  }

  // RPC method called by the `Sandbox` Durable Object (over the Service
  // Binding to this Worker) for the context execute path -- see
  // docs/sandbox-1-0-design.md, "Workspace mirror and sync protocol". Errors
  // are returned as `{ ok: false, status, body }` rather than thrown (Workers
  // RPC only serializes `name`/`message`/`stack` off a thrown `Error`, which
  // would drop the `code`/`details`/HTTP status the sandbox relies on).
  async executeInContext(
    key: string,
    args: InterpreterExecuteArgs,
    getFiles: GetWorkspaceFiles,
  ): Promise<InterpreterExecuteRpcResult> {
    if (!INTERPRETER_KEY.test(key)) {
      const { status, body } = errorBody(new ApiError(400, "Invalid interpreter key"));
      return { ok: false, status, body };
    }
    if (!this.env.INTERPRETER) {
      const { status, body } = errorBody(new ApiError(400, NO_INTERPRETER_BINDING));
      return { ok: false, status, body };
    }
    const stub = this.env.INTERPRETER.get(this.env.INTERPRETER.idFromName(key)) as unknown as InterpreterStub;
    // Forwarded directly: a stub received over RPC (`getFiles`, from the
    // `Sandbox` Durable Object) may be forwarded over RPC again to another
    // Worker/Durable Object, per Cloudflare's RPC contract.
    return stub.executeInContext(key, args, getFiles);
  }
}
