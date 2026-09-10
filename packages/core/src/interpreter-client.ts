// The caller side of the sandbox Durable Object -> runtime Worker wire
// protocol (see docs/sandbox-1-0-design.md, "Wire protocol: sandbox Durable
// Object -> runtime Worker"). One `InterpreterClient` wraps one Service
// Binding to a runtime Worker (`target`) plus the name it was looked up by
// (`name`, used only for error messages -- the same messages `Sandbox` used
// to build itself before this class existed). Used by `Sandbox`
// (`sandbox.ts`), the free `runCode()` (`client.ts`), and the gateway's own
// `/execute` route (`src/index.ts`).
import {
  ApiError,
  INTERPRETER_PROTOCOL_VERSION,
  type ExecutionRequest,
  type GetWorkspaceFiles,
  type InterpreterExecuteArgs,
  type InterpreterExecuteRpcResult,
  type InterpreterInfo,
  type RuntimeBinding,
} from "./protocol.js";

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isInterpreterInfo(body: unknown): body is InterpreterInfo {
  if (!body || typeof body !== "object") return false;
  const value = body as Record<string, unknown>;
  if (typeof value.language !== "string") return false;
  if (typeof value.engine !== "string") return false;
  if (typeof value.contexts !== "boolean") return false;
  if (value.protocol !== undefined && typeof value.protocol !== "number") return false;
  return true;
}

/**
 * One runtime Worker binding, addressed by the wire protocol described in
 * docs/sandbox-1-0-design.md. Every request URL is
 * `https://sandbox.internal<path>`, matching what the real Service Binding
 * (and every test fake) expects; headers/bodies are otherwise identical to
 * what `Sandbox` built by hand before this class existed.
 */
export class InterpreterClient {
  private readonly target: RuntimeBinding;

  /**
   * Throws `ApiError(400, "Unknown binding '${name}'")` unless `target` has
   * a `fetch` function -- the only "does this binding exist" check anywhere
   * on the execute path (see the module comment in `sandbox.ts`): a real
   * Service Binding always reads every property as a function (RPC promise
   * pipelining), so this checks `fetch` specifically rather than
   * feature-detecting `executeInContext`.
   */
  constructor(
    target: unknown,
    public readonly name: string,
  ) {
    if (!target || typeof (target as { fetch?: unknown }).fetch !== "function")
      throw new ApiError(400, `Unknown binding '${name}'`);
    this.target = target as RuntimeBinding;
  }

  /** The `BINDING_NAME` shape a binding name must match before it's looked up at all. */
  static isBindingName(name: string): boolean {
    return BINDING_NAME.test(name);
  }

  private async fetchPath(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return this.target.fetch(new Request(`https://sandbox.internal${path}`, init));
  }

  /**
   * GET /interpreter: the full binding-validation probe (name shape,
   * presence, and the runtime's own answer) -- only ever called from
   * `createCodeContext`/default-context resolution, never per execute (see
   * `sandbox.ts`'s `probeBinding`, which this replaces). Also validates the
   * wire protocol version: a missing `protocol` means 1 (a runtime Worker
   * built before the field existed); anything other than
   * `INTERPRETER_PROTOCOL_VERSION` is rejected.
   */
  async info(): Promise<InterpreterInfo> {
    let response: Response;
    try {
      response = await this.fetchPath("GET", "/interpreter");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, `Binding '${this.name}' is not a sandbox-workers runtime Worker`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(400, `Binding '${this.name}' is not a sandbox-workers runtime Worker`);
    }
    if (!isInterpreterInfo(body))
      throw new ApiError(400, `Binding '${this.name}' is not a sandbox-workers runtime Worker`);
    const protocol = body.protocol ?? 1;
    if (protocol !== INTERPRETER_PROTOCOL_VERSION)
      throw new ApiError(
        400,
        `Binding '${this.name}' speaks interpreter protocol ${protocol}; this caller supports ${INTERPRETER_PROTOCOL_VERSION}`,
      );
    return body;
  }

  /** POST /interpreters/:key/contexts. The runtime's error response is relayed by the caller (see `Sandbox`'s `RelayedResponse`), not parsed here. */
  createContext(key: string, body: { id: string; cwd: string }): Promise<Response> {
    return this.fetchPath("POST", `/interpreters/${key}/contexts`, body);
  }

  /** DELETE /interpreters/:key/contexts/:id. */
  deleteContext(key: string, id: string): Promise<Response> {
    return this.fetchPath("DELETE", `/interpreters/${key}/contexts/${encodeURIComponent(id)}`);
  }

  /** DELETE /interpreters/:key -- best-effort handling (ignoring failures) stays with the caller. */
  destroy(key: string): Promise<Response> {
    return this.fetchPath("DELETE", `/interpreters/${key}`);
  }

  /** POST /execute (stateless). `init.signal`, when given, aborts the underlying fetch. */
  execute(body: ExecutionRequest, init?: { signal?: AbortSignal }): Promise<Response> {
    const reqInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (init?.signal) reqInit.signal = init.signal;
    return this.target.fetch(new Request("https://sandbox.internal/execute", reqInit));
  }

  /**
   * Plain forward to the runtime Worker entrypoint's `executeInContext` RPC
   * method. A thrown error here means the RPC call itself failed (transport
   * failure, or the method missing on an old runtime deployment) -- not an
   * application-level error, which the runtime returns as `{ ok: false,
   * ... }` instead of throwing (see `InterpreterExecuteRpcResult`); wrapping
   * a thrown error into a 502 stays with the caller (`Sandbox`), which has
   * the binding name handy for the message.
   */
  executeInContext(
    key: string,
    args: InterpreterExecuteArgs,
    getFiles: GetWorkspaceFiles,
  ): Promise<InterpreterExecuteRpcResult> {
    return this.target.executeInContext(key, args, getFiles);
  }
}
