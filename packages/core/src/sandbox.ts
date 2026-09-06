// The caller-hosted `Sandbox` Durable Object (see docs/sandbox-1-0-design.md,
// "Model" -> Sandbox). Exported from the caller's own Worker
// (`export { Sandbox } from "@sandbox-workers/core"`) and reached through
// `getSandbox(env.Sandbox, id)` (client.ts). It owns `/workspace` (files and
// directories), envVars, the context registry, and idle expiry -- but no
// Wasm: code contexts are bound to a runtime Worker (one language each) by
// the name of a Service Binding in the caller's own environment, and every
// execution is proxied to that binding's interpreter Durable Object
// (`runtime/interpreter.mjs`), which mirrors `/workspace` in memory and
// reconciles it on every request (see "Workspace mirror and sync protocol").
//
// This is a plain class -- it does not extend `cloudflare:workers`'s
// `DurableObject` and does not import from `cloudflare:workers` at all, so
// `@sandbox-workers/core` keeps its `types: []` tsconfig (no build-time
// dependency on Workers types). `state`/`env` are typed structurally below.
import {
  ApiError,
  errnoErrorResponse,
  errorResponse,
  MAX_CODE_BYTES,
  MAX_FILES_REQUEST_BYTES,
  MAX_REQUEST_BYTES,
  type InterpreterExecuteResponse,
  type InterpreterInfo,
  type InterpreterSyncRequest,
} from "./protocol.js";
import { ErrorCode, Operation, type OperationType } from "./errors.js";
import { Workspace, WorkspaceError, type SerializedRow } from "./workspace.js";
import { validateSandboxId } from "./client.js";

// --- structural host types ---------------------------------------------
//
// Declared here (rather than imported from `@cloudflare/workers-types`) so
// this package has no build-time dependency on Workers types. A real
// `DurableObjectState`/its `env` satisfy these structurally.

export interface SqlStorageLike {
  exec(query: string, ...params: unknown[]): Iterable<Record<string, unknown>>;
}
export interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  transactionSync<T>(closure: () => T): T;
  deleteAll(): unknown;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface DurableObjectStateLike {
  id: { toString(): string };
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
/**
 * `SANDBOX_IDLE_TTL_MS` plus arbitrary bindings (Service Bindings to runtime
 * Workers, named however the caller likes -- `createCodeContext({ binding })`
 * looks them up by name at request time).
 */
export interface SandboxEnv {
  SANDBOX_IDLE_TTL_MS?: string;
  [binding: string]: unknown;
}

type Fetcher = { fetch(request: Request): Promise<Response> };

// --- constants -----------------------------------------------------------

const SANDBOX_ID_HEADER = "x-sandbox-id";
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CONTEXTS = 8;
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

const FILE_OPERATION: Record<string, OperationType> = {
  read: Operation.FILE_READ,
  write: Operation.FILE_WRITE,
  mkdir: Operation.DIRECTORY_CREATE,
  delete: Operation.FILE_DELETE,
  rename: Operation.FILE_RENAME,
  move: Operation.FILE_MOVE,
  list: Operation.DIRECTORY_LIST,
  exists: Operation.FILE_STAT,
};

const MIME_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".py": "text/x-python",
  ".pl": "text/x-perl",
  ".rb": "text/x-ruby",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

// --- shapes ---------------------------------------------------------------

interface SandboxMeta {
  format: 1;
  id: string;
  createdAt: string;
  lastUsed: string;
  envVars: Record<string, string>;
  lifetime: string;
}

interface ContextRecord {
  id: string;
  binding: string;
  language: string;
  engine: string;
  cwd: string;
  envVars: Record<string, string>;
  createdAt: string;
  lastUsed: string;
  executions: number;
  snapshot: {
    build: string;
    pages: number;
    bytes: number;
    storedBytes: number;
    takenAt: number;
    stale: boolean;
  } | null;
}

/** Thrown to relay a `Response` (built from another Worker's answer) unchanged through `_handle`'s catch. */
class RelayedResponse {
  constructor(public readonly response: Response) {}
}

// --- small helpers ----------------------------------------------------------

function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" }, ...init });
}

async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_REQUEST_BYTES,
): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new ApiError(413, "Request too large");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "Expected an object");
  return body as Record<string, unknown>;
}

/**
 * Validates an envVars object: keys must be valid identifiers, values must
 * be a string (sets the var) or, when `allowNull`, `null` (unsets it -- the
 * wire encoding of the client's `undefined`, see `setEnvVars`). Returns
 * `raw` unchanged, or undefined if `raw` itself is undefined.
 */
function validateEnvVars(
  raw: unknown,
  { allowNull = false }: { allowNull?: boolean } = {},
): Record<string, string | null> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ApiError(400, "envVars must be an object");
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_VAR_KEY.test(key)) throw new ApiError(400, `Invalid envVars key: ${key}`);
    if (value === null && allowNull) continue;
    if (typeof value !== "string") throw new ApiError(400, "envVars values must be strings");
  }
  return raw as Record<string, string | null>;
}

/**
 * Execution env = sandbox envVars, then the context's own, then this call's
 * -- a later source overrides an earlier one, and an explicit `null` (from
 * this call or a previous setEnvVars) unsets the key rather than passing the
 * string "null" through to the guest.
 */
function computeExecutionEnv(
  sandboxEnvVars: Record<string, string>,
  contextEnvVars: Record<string, string>,
  callEnvVars: Record<string, string | null> | undefined,
): Record<string, string> {
  const merged: Record<string, string | null | undefined> = {
    ...sandboxEnvVars,
    ...contextEnvVars,
    ...(callEnvVars ?? {}),
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined) continue;
    env[key] = value;
  }
  return env;
}

function validateFilesBody(body: Record<string, unknown>): void {
  const ops = new Set(["read", "write", "mkdir", "delete", "rename", "move", "list", "exists"]);
  if (typeof body.op !== "string" || !ops.has(body.op)) throw new ApiError(400, "Unknown op");
  if (typeof body.path !== "string" || !body.path) throw new ApiError(400, "path is required");
  if (
    (body.op === "rename" || body.op === "move") &&
    (typeof body.newPath !== "string" || !body.newPath)
  )
    throw new ApiError(400, `newPath is required for ${body.op}`);
  if (body.encoding !== undefined && body.encoding !== "utf-8" && body.encoding !== "base64")
    throw new ApiError(400, "encoding must be utf-8 or base64");
}

function mimeTypeFor(path: string, isBinary: boolean): string {
  const match = /\.[^./]+$/.exec(path);
  const type = match ? MIME_TYPES[match[0].toLowerCase()] : undefined;
  return type ?? (isBinary ? "application/octet-stream" : "text/plain");
}

function isHidden(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Maps a `Workspace.list()` entry to the SDK's `FileInfo` shape.
 * `baseAbsolute` is the normalized directory that was listed, used to derive
 * `relativePath`; directories report the sandbox's own createdAt as
 * `modifiedAt` because the workspace doesn't track directory mtimes.
 */
function toFileInfo(
  entry: { path: string; type: "file" | "directory"; size: number; updatedAt: number },
  baseAbsolute: string,
  sandboxCreatedAt: string,
) {
  const name = entry.path.split("/").pop() as string;
  const relativePath = entry.path.startsWith(`${baseAbsolute}/`)
    ? entry.path.slice(baseAbsolute.length + 1)
    : name;
  const isDir = entry.type === "directory";
  return {
    name,
    absolutePath: entry.path,
    relativePath,
    type: entry.type,
    size: entry.size,
    modifiedAt: isDir ? sandboxCreatedAt : new Date(entry.updatedAt || Date.now()).toISOString(),
    mode: isDir ? "drwxr-xr-x" : "-rw-r--r--",
    permissions: { readable: true, writable: true, executable: isDir },
  };
}

function isInterpreterInfo(body: unknown): body is InterpreterInfo {
  return (
    !!body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).language === "string" &&
    typeof (body as Record<string, unknown>).engine === "string" &&
    typeof (body as Record<string, unknown>).contexts === "boolean"
  );
}

// --- the Sandbox Durable Object ---------------------------------------------

export class Sandbox {
  private readonly state: DurableObjectStateLike;
  private readonly env: SandboxEnv;
  private workspace: Workspace | null = null;
  /** File-hash diffing state for `_persistWorkspace` (mirrors `Workspace.changes(since)`'s contract). */
  private changesSince: Map<string, string> | undefined;
  /** Directory paths last written to the `files` table, kept in memory so a directory diff never needs a read. */
  private persistedDirs: Set<string> | null = null;
  /** In-memory only: per-binding file manifest ({path: hash}) that binding's interpreter is known to hold after the last successful execute. Empty after eviction. */
  private sent: Map<string, Record<string, string>> = new Map();
  private alarmAt: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(state: DurableObjectStateLike, env: SandboxEnv) {
    this.state = state;
    this.env = env;
    state.blockConcurrencyWhile(async () => {
      await this.ensureSchema();
    });
  }

  // --- schema -------------------------------------------------------------

  private createTables(): void {
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, data BLOB, updated_at INTEGER)",
    );
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS contexts (id TEXT PRIMARY KEY, value TEXT)");
  }

  // Wipes storage on anything but the current format 1: a `chunks`/`pages`
  // table (this Durable Object was pointed at interpreter-shaped storage) or
  // a `meta.sandbox` row whose format isn't 1. There is no migration -- wipe
  // and start clean, as every format change elsewhere in this repo does.
  private async ensureSchema(): Promise<void> {
    const tableExists = (name: string): boolean =>
      [
        ...this.state.storage.sql.exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          name,
        ),
      ].length > 0;
    const hasChunksTable = tableExists("chunks");
    const hasPagesTable = tableExists("pages");
    const hasMetaTable = tableExists("meta");
    let wipe = hasChunksTable || hasPagesTable;
    if (!wipe && hasMetaTable) {
      const rows = [
        ...this.state.storage.sql.exec("SELECT value FROM meta WHERE key = 'sandbox'"),
      ];
      if (rows.length) {
        const meta = JSON.parse(rows[0].value as string) as { format?: number };
        if (meta.format !== 1) wipe = true;
      } else {
        const other = [...this.state.storage.sql.exec("SELECT 1 FROM meta WHERE key != 'sandbox'")];
        if (other.length) wipe = true;
      }
    }
    if (wipe) await this.state.storage.deleteAll();
    this.createTables();
  }

  // --- sandbox meta ---------------------------------------------------------

  private loadSandboxMeta(): SandboxMeta | null {
    const rows = [...this.state.storage.sql.exec("SELECT value FROM meta WHERE key = 'sandbox'")];
    return rows.length ? (JSON.parse(rows[0].value as string) as SandboxMeta) : null;
  }

  private saveSandboxMeta(meta: SandboxMeta): void {
    this.state.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('sandbox', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
      JSON.stringify(meta),
    );
  }

  private ensureSandboxMeta(id: string): SandboxMeta {
    let meta = this.loadSandboxMeta();
    if (!meta) {
      const now = new Date().toISOString();
      meta = {
        format: 1,
        id,
        createdAt: now,
        lastUsed: now,
        envVars: {},
        lifetime: crypto.randomUUID(),
      };
      this.saveSandboxMeta(meta);
    }
    return meta;
  }

  // --- workspace --------------------------------------------------------

  private loadFileRows(): SerializedRow[] {
    return [...this.state.storage.sql.exec("SELECT path, data, updated_at FROM files")].map((row) => ({
      path: row.path as string,
      data: row.data as Uint8Array | null,
      updatedAt: row.updated_at as number,
    }));
  }

  private ensureWorkspace(): Workspace {
    if (!this.workspace) {
      const rows = this.loadFileRows();
      this.workspace = Workspace.load(rows);
      this.changesSince = this.workspace.changes().snapshot;
      this.persistedDirs = new Set(rows.filter((r) => r.data === null).map((r) => r.path));
    }
    return this.workspace;
  }

  // Persists the file/directory diff against what's stored, plus `context`
  // (when given) -- all in one transaction. File diffing reuses
  // `Workspace.changes(since)` (kept in `this.changesSince`); directory
  // diffing compares the current directory list against `this.persistedDirs`
  // (kept in memory, per docs/sandbox-1-0-design.md), so an empty directory
  // (nothing `changes()` would ever report) still gets persisted.
  private persistWorkspace(context?: ContextRecord): void {
    const workspace = this.ensureWorkspace();
    const fileDiff = workspace.changes(this.changesSince);
    this.changesSince = fileDiff.snapshot;
    const currentDirs = new Set(workspace.manifest().dirs);
    const prevDirs = this.persistedDirs ?? new Set<string>();
    const addedDirs = [...currentDirs].filter((d) => !prevDirs.has(d));
    const removedDirs = [...prevDirs].filter((d) => !currentDirs.has(d));
    this.persistedDirs = currentDirs;
    const byPath = new Map(workspace.serialize().map((f) => [f.path, f]));
    this.state.storage.transactionSync(() => {
      for (const path of fileDiff.deleted)
        this.state.storage.sql.exec("DELETE FROM files WHERE path = ?", path);
      for (const path of [...fileDiff.created, ...fileDiff.updated]) {
        const file = byPath.get(path);
        if (!file || file.data === null) continue;
        this.state.storage.sql.exec(
          "INSERT INTO files (path, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET data = ?2, updated_at = ?3",
          path,
          file.data,
          file.updatedAt,
        );
      }
      for (const dir of removedDirs)
        this.state.storage.sql.exec("DELETE FROM files WHERE path = ?", dir);
      for (const dir of addedDirs) {
        this.state.storage.sql.exec(
          "INSERT INTO files (path, data, updated_at) VALUES (?1, NULL, 0) ON CONFLICT(path) DO UPDATE SET data = NULL, updated_at = 0",
          dir,
        );
      }
      if (context) this.saveContext(context);
    });
  }

  // --- contexts ---------------------------------------------------------

  private loadContextRow(id: string): ContextRecord | null {
    const rows = [...this.state.storage.sql.exec("SELECT value FROM contexts WHERE id = ?", id)];
    return rows.length ? (JSON.parse(rows[0].value as string) as ContextRecord) : null;
  }

  private loadAllContexts(): ContextRecord[] {
    return [...this.state.storage.sql.exec("SELECT value FROM contexts")].map(
      (row) => JSON.parse(row.value as string) as ContextRecord,
    );
  }

  private saveContext(context: ContextRecord): void {
    this.state.storage.sql.exec(
      "INSERT INTO contexts (id, value) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET value = ?2",
      context.id,
      JSON.stringify(context),
    );
  }

  private deleteContextRow(id: string): void {
    this.state.storage.sql.exec("DELETE FROM contexts WHERE id = ?", id);
  }

  private interpreterKey(): string {
    return this.state.id.toString();
  }

  private async fetchBinding(
    binding: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const target = this.env[binding] as Fetcher | undefined;
    if (!target || typeof target.fetch !== "function")
      throw new ApiError(400, `Unknown binding '${binding}'`);
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return target.fetch(new Request(`https://sandbox.internal${path}`, init));
  }

  // Full binding validation (name shape, presence, and the GET /interpreter
  // probe): only ever called from createCodeContext/default-context creation
  // (docs/sandbox-1-0-design.md), never per execute.
  private async probeBinding(binding: string): Promise<InterpreterInfo> {
    if (!BINDING_NAME.test(binding)) throw new ApiError(400, `Unknown binding '${binding}'`);
    let response: Response;
    try {
      response = await this.fetchBinding(binding, "GET", "/interpreter");
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, `Binding '${binding}' is not a sandbox-workers runtime Worker`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(400, `Binding '${binding}' is not a sandbox-workers runtime Worker`);
    }
    if (!isInterpreterInfo(body))
      throw new ApiError(400, `Binding '${binding}' is not a sandbox-workers runtime Worker`);
    return body;
  }

  // Registers a new context both remotely (POST /interpreters/<key>/contexts)
  // and locally. `info`, when already probed by the caller (default-context
  // resolution), is reused instead of probing again.
  private async registerContext(
    binding: string,
    cwd: string,
    envVars: Record<string, string>,
    info?: InterpreterInfo,
  ): Promise<ContextRecord> {
    if (this.loadAllContexts().length >= MAX_CONTEXTS)
      throw new ApiError(400, `Cannot create more than ${MAX_CONTEXTS} code contexts`);
    const resolvedInfo = info ?? (await this.probeBinding(binding));
    if (!resolvedInfo.contexts)
      throw new ApiError(
        400,
        `Code contexts are not supported by binding '${binding}' (${resolvedInfo.language})`,
      );
    const id = crypto.randomUUID();
    const response = await this.fetchBinding(
      binding,
      "POST",
      `/interpreters/${this.interpreterKey()}/contexts`,
      { id, cwd },
    );
    if (!response.ok) throw new RelayedResponse(await this.rebuildResponse(response));
    const now = new Date().toISOString();
    const context: ContextRecord = {
      id,
      binding,
      language: resolvedInfo.language,
      engine: resolvedInfo.engine,
      cwd,
      envVars,
      createdAt: now,
      lastUsed: now,
      executions: 0,
      snapshot: null,
    };
    this.saveContext(context);
    return context;
  }

  // runCode without a contextId requires `binding` and reuses the oldest
  // existing context for it, creating one under /workspace when none exists
  // -- unless the binding reports `contexts: false`, in which case the
  // caller falls back to the stateless path.
  private async resolveDefaultContext(
    binding: string,
  ): Promise<ContextRecord | { stateless: true }> {
    const existing = this.loadAllContexts()
      .filter((c) => c.binding === binding)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (existing) return existing;
    const info = await this.probeBinding(binding);
    if (!info.contexts) return { stateless: true };
    return this.registerContext(binding, "/workspace", {}, info);
  }

  private async deleteContext(contextId: string): Promise<void> {
    const context = this.loadContextRow(contextId);
    if (!context)
      throw new ApiError(404, `Code context '${contextId}' not found`, ErrorCode.CONTEXT_NOT_FOUND, {
        contextId,
      });
    try {
      await this.fetchBinding(
        context.binding,
        "DELETE",
        `/interpreters/${this.interpreterKey()}/contexts/${encodeURIComponent(context.id)}`,
      );
    } catch {
      // Best-effort: the interpreter forgets this context on its own idle
      // expiry even if this call fails.
    }
    this.deleteContextRow(contextId);
  }

  private async rebuildResponse(response: Response): Promise<Response> {
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  // --- idle expiry ------------------------------------------------------

  private idleTtlMs(): number {
    const raw = this.env.SANDBOX_IDLE_TTL_MS;
    if (raw === undefined || raw === null || raw === "") return DEFAULT_IDLE_TTL_MS;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_IDLE_TTL_MS;
  }

  // Same throttled alarm policy as runtime/interpreter.mjs's _touchAlarm
  // (docs/snapshot-cost-design.md, "Alarm policy"): re-arms only when the new
  // deadline is more than TTL/10 past the deadline actually armed, so a
  // sandbox may be destroyed after as little as 0.9 x TTL of inactivity.
  private async touchAlarm(meta: SandboxMeta, { metaAlreadyWritten = false } = {}): Promise<number | null> {
    const ttl = this.idleTtlMs();
    if (ttl === 0) {
      const armed = this.alarmAt ?? (await this.state.storage.getAlarm());
      if (armed != null) await this.state.storage.deleteAlarm();
      this.alarmAt = null;
      return null;
    }
    const now = Date.now();
    const armed = this.alarmAt ?? (await this.state.storage.getAlarm());
    this.alarmAt = armed;
    const want = now + ttl;
    if (armed == null || want - armed > ttl / 10) {
      await this.state.storage.setAlarm(want);
      this.alarmAt = want;
      if (!metaAlreadyWritten) {
        meta.lastUsed = new Date(now).toISOString();
        this.saveSandboxMeta(meta);
      }
      return want;
    }
    return armed;
  }

  // Shared by DELETE / and the alarm handler: best-effort DELETE
  // /interpreters/<key> on every binding a context referenced, then wipe all
  // storage and in-memory state.
  private async destroy(): Promise<void> {
    const bindings = new Set(this.loadAllContexts().map((c) => c.binding));
    const key = this.interpreterKey();
    for (const binding of bindings) {
      try {
        const target = this.env[binding] as Fetcher | undefined;
        if (target && typeof target.fetch === "function")
          await target.fetch(new Request(`https://sandbox.internal/interpreters/${key}`, { method: "DELETE" }));
      } catch {
        // best-effort
      }
    }
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
    this.createTables();
    this.workspace = null;
    this.changesSince = undefined;
    this.persistedDirs = null;
    this.sent = new Map();
    this.alarmAt = null;
  }

  async alarm(): Promise<void> {
    const meta = this.loadSandboxMeta();
    const ttl = this.idleTtlMs();
    if (meta == null || ttl === 0) return;
    const deadline = Date.parse(meta.lastUsed) + ttl;
    if (deadline > Date.now()) {
      await this.state.storage.setAlarm(deadline);
      this.alarmAt = deadline;
      return;
    }
    await this.destroy();
  }

  // --- HTTP surface --------------------------------------------------

  // Requests are serialized with a promise chain: fetch() would otherwise
  // interleave at any await point, racing two executions against the same
  // in-memory workspace/sent state.
  async fetch(request: Request): Promise<Response> {
    const run = () => this.handle(request);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const rawId = request.headers.get(SANDBOX_ID_HEADER) ?? "";
      try {
        validateSandboxId(rawId);
      } catch (error) {
        throw new ApiError(400, error instanceof Error ? error.message : "Invalid sandbox id");
      }
      const path = new URL(request.url).pathname;
      const method = request.method;

      if (method === "DELETE" && path === "/") {
        await this.destroy();
        return json({ success: true });
      }

      const sandboxMeta = this.ensureSandboxMeta(rawId);

      if (method === "GET" && path === "/") return await this.handleInfo(sandboxMeta);
      if (method === "POST" && path === "/execute") return await this.handleExecute(request, sandboxMeta);
      if (method === "POST" && path === "/contexts") return await this.handleCreateContext(request, sandboxMeta);
      if (method === "GET" && path === "/contexts") return await this.handleListContexts(sandboxMeta);
      const contextMatch = /^\/contexts\/([^/]+)$/.exec(path);
      if (method === "DELETE" && contextMatch) {
        await this.deleteContext(decodeURIComponent(contextMatch[1]));
        await this.touchAlarm(sandboxMeta);
        return json({ success: true });
      }
      if (method === "POST" && path === "/env") return await this.handleSetEnv(request, sandboxMeta);
      if (method === "POST" && path === "/files") return await this.handleFiles(request, sandboxMeta);

      throw new ApiError(404, "Not found", ErrorCode.VALIDATION_FAILED);
    } catch (error) {
      if (error instanceof RelayedResponse) return error.response;
      if (error instanceof WorkspaceError) return errnoErrorResponse(error.code, error.message, {});
      return errorResponse(error);
    }
  }

  private async handleInfo(sandboxMeta: SandboxMeta): Promise<Response> {
    const workspace = this.ensureWorkspace();
    const contexts = this.loadAllContexts().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const expiresAt = await this.touchAlarm(sandboxMeta);
    return json({
      id: sandboxMeta.id,
      createdAt: sandboxMeta.createdAt,
      lastUsed: sandboxMeta.lastUsed,
      envVars: sandboxMeta.envVars,
      contexts: contexts.map((context) => ({
        id: context.id,
        binding: context.binding,
        language: context.language,
        engine: context.engine,
        cwd: context.cwd,
        createdAt: context.createdAt,
        lastUsed: context.lastUsed,
        executions: context.executions,
        snapshot: context.snapshot,
      })),
      workspace: workspace.stats(),
      expiresAt,
    });
  }

  private async handleCreateContext(request: Request, sandboxMeta: SandboxMeta): Promise<Response> {
    const body = await readJsonBody(request);
    if (typeof body.binding !== "string" || !body.binding)
      throw new ApiError(400, "binding is required");
    let cwd = "/workspace";
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string" || !body.cwd)
        throw new ApiError(400, "cwd must be a non-empty string");
      const workspace = this.ensureWorkspace();
      try {
        cwd = workspace.normalize(body.cwd, "/workspace").absolute;
      } catch (error) {
        throw new ApiError(400, error instanceof WorkspaceError ? error.message : "Invalid cwd");
      }
    }
    const rawEnvVars = validateEnvVars(body.envVars) ?? {};
    const envVars = rawEnvVars as Record<string, string>;
    const context = await this.registerContext(body.binding, cwd, envVars);
    await this.touchAlarm(sandboxMeta);
    return json(
      {
        id: context.id,
        binding: context.binding,
        language: context.language,
        cwd: context.cwd,
        createdAt: context.createdAt,
        lastUsed: context.lastUsed,
      },
      { status: 201 },
    );
  }

  private async handleListContexts(sandboxMeta: SandboxMeta): Promise<Response> {
    const contexts = this.loadAllContexts().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await this.touchAlarm(sandboxMeta);
    return json({
      contexts: contexts.map((context) => ({
        id: context.id,
        binding: context.binding,
        language: context.language,
        cwd: context.cwd,
        createdAt: context.createdAt,
        lastUsed: context.lastUsed,
      })),
    });
  }

  private async handleSetEnv(request: Request, sandboxMeta: SandboxMeta): Promise<Response> {
    const body = await readJsonBody(request);
    const envVars = validateEnvVars(body.envVars, { allowNull: true });
    if (envVars === undefined) throw new ApiError(400, "envVars is required");
    const nextEnv = { ...sandboxMeta.envVars };
    for (const [key, value] of Object.entries(envVars)) {
      if (value === null) delete nextEnv[key];
      else nextEnv[key] = value;
    }
    sandboxMeta.envVars = nextEnv;
    sandboxMeta.lastUsed = new Date().toISOString();
    this.saveSandboxMeta(sandboxMeta);
    await this.touchAlarm(sandboxMeta, { metaAlreadyWritten: true });
    return json({ success: true });
  }

  private async executeStateless(
    binding: string,
    code: string,
    callEnvVars: Record<string, string | null> | undefined,
    sandboxMeta: SandboxMeta,
  ): Promise<Response> {
    const envVars = computeExecutionEnv(sandboxMeta.envVars, {}, callEnvVars);
    const response = await this.fetchBinding(binding, "POST", "/execute", { code, envVars });
    await this.touchAlarm(sandboxMeta);
    return this.rebuildResponse(response);
  }

  private async handleExecute(request: Request, sandboxMeta: SandboxMeta): Promise<Response> {
    const body = await readJsonBody(request);
    if (body.cwd !== undefined)
      throw new ApiError(400, "cwd is a context property; pass it to createCodeContext");
    if (typeof body.code !== "string" || !body.code.trim())
      throw new ApiError(400, "Non-empty code is required");
    if (new TextEncoder().encode(body.code).length > MAX_CODE_BYTES)
      throw new ApiError(413, "Code exceeds 64 KiB");
    const callEnvVars = validateEnvVars(body.envVars, { allowNull: true });
    if (body.contextId !== undefined && (typeof body.contextId !== "string" || !body.contextId))
      throw new ApiError(400, "contextId must be a non-empty string");
    if (body.binding !== undefined && (typeof body.binding !== "string" || !body.binding))
      throw new ApiError(400, "binding must be a non-empty string");

    let context: ContextRecord;
    if (typeof body.contextId === "string") {
      const found = this.loadContextRow(body.contextId);
      if (!found)
        throw new ApiError(404, `Code context '${body.contextId}' not found`, ErrorCode.CONTEXT_NOT_FOUND, {
          contextId: body.contextId,
        });
      context = found;
    } else if (typeof body.binding === "string") {
      const resolved = await this.resolveDefaultContext(body.binding);
      if ("stateless" in resolved)
        return await this.executeStateless(body.binding, body.code, callEnvVars, sandboxMeta);
      context = resolved;
    } else {
      throw new ApiError(400, "Pass a context or a binding");
    }

    const workspace = this.ensureWorkspace();
    const envVars = computeExecutionEnv(sandboxMeta.envVars, context.envVars, callEnvVars);
    const key = this.interpreterKey();

    let payload = this.buildSyncPayload(workspace, context.binding);
    let response = await this.fetchBinding(context.binding, "POST", `/interpreters/${key}/execute`, {
      contextId: context.id,
      code: body.code,
      envVars,
      workspace: payload,
    });
    let data = await this.readInterpreterResponse(response, context);

    if ("resync" in data && data.resync) {
      const missingFiles = (data.missing as string[]).map((path) => {
        const read = workspace.read(path, "/workspace", { encoding: "base64" });
        return { path, data: read.content, updatedAt: read.updatedAt };
      });
      payload = { ...payload, files: [...payload.files, ...missingFiles] };
      response = await this.fetchBinding(context.binding, "POST", `/interpreters/${key}/execute`, {
        contextId: context.id,
        code: body.code,
        envVars,
        workspace: payload,
      });
      data = await this.readInterpreterResponse(response, context);
      if ("resync" in data && data.resync)
        throw new ApiError(500, "Interpreter requested a second resync", ErrorCode.INTERNAL_ERROR);
    }

    const result = data as unknown as InterpreterExecuteResponse;
    workspace.applySync({
      dirs: result.workspace.dirs,
      files: result.workspace.files,
      deleted: result.workspace.deleted,
    });
    this.sent.set(context.binding, workspace.manifest().files);

    context.executions++;
    context.lastUsed = new Date().toISOString();
    context.cwd = result.context.cwd;
    context.snapshot = result.context.snapshot;
    this.persistWorkspace(context);

    const expiresAt = await this.touchAlarm(sandboxMeta);
    const { context: _resultContext, workspace: _resultWorkspace, executionCount: _resultCount, ...rest } = result;
    return json({
      ...rest,
      executionCount: context.executions,
      context: {
        id: context.id,
        cwd: context.cwd,
        executions: context.executions,
        ...(result.context.snapshotMs !== undefined ? { snapshotMs: result.context.snapshotMs } : {}),
        ...(expiresAt !== null ? { expiresAt } : {}),
      },
    });
  }

  private buildSyncPayload(workspace: Workspace, binding: string): InterpreterSyncRequest {
    const manifest = workspace.manifest();
    const sentManifest = this.sent.get(binding);
    const files: InterpreterSyncRequest["files"] = [];
    for (const [path, hash] of Object.entries(manifest.files)) {
      if (!sentManifest || sentManifest[path] !== hash) {
        const read = workspace.read(path, "/workspace", { encoding: "base64" });
        files.push({ path, data: read.content, updatedAt: read.updatedAt });
      }
    }
    return { dirs: manifest.dirs, manifest: manifest.files, files };
  }

  // Parses the interpreter's execute response, handling the two non-2xx
  // cases the sandbox understands itself (CONTEXT_NOT_FOUND: drop the
  // registry row and re-throw as 404; anything else: relay unchanged) before
  // returning the parsed body (a `resync` payload or an `InterpreterExecuteResponse`).
  private async readInterpreterResponse(
    response: Response,
    context: ContextRecord,
  ): Promise<Record<string, unknown>> {
    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new RelayedResponse(
        new Response(text, {
          status: response.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
      );
    }
    if (!response.ok) {
      if (data.code === ErrorCode.CONTEXT_NOT_FOUND) {
        this.deleteContextRow(context.id);
        throw new ApiError(404, `Code context '${context.id}' not found`, ErrorCode.CONTEXT_NOT_FOUND, {
          contextId: context.id,
        });
      }
      throw new RelayedResponse(
        new Response(text, {
          status: response.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
      );
    }
    return data;
  }

  private async handleFiles(request: Request, sandboxMeta: SandboxMeta): Promise<Response> {
    const body = await readJsonBody(request, MAX_FILES_REQUEST_BYTES);
    validateFilesBody(body);
    const workspace = this.ensureWorkspace();
    const cwd = "/workspace";
    const timestamp = new Date().toISOString();
    const op = body.op as string;
    const operation = FILE_OPERATION[op];
    try {
      const path = workspace.normalize(body.path as string, cwd).absolute;
      let response: Response;
      switch (op) {
        case "read": {
          const result = workspace.read(body.path as string, cwd, {
            encoding: body.encoding as "utf-8" | "base64" | undefined,
          });
          response = json({
            success: true,
            path,
            content: result.content,
            encoding: result.encoding,
            isBinary: result.isBinary,
            mimeType: mimeTypeFor(path, result.isBinary),
            size: result.size,
            timestamp,
          });
          break;
        }
        case "write":
          workspace.write(body.path as string, cwd, (body.content as string) ?? "", {
            encoding: body.encoding as "utf-8" | "base64" | undefined,
          });
          response = json({ success: true, path, timestamp });
          break;
        case "mkdir":
          workspace.mkdir(body.path as string, cwd, { recursive: !!body.recursive });
          response = json({ success: true, path, recursive: !!body.recursive, timestamp });
          break;
        case "delete":
          workspace.delete(body.path as string, cwd, {
            recursive: !!body.recursive,
            force: !!body.force,
          });
          response = json({ success: true, path, timestamp });
          break;
        case "rename":
        case "move": {
          workspace.rename(body.path as string, body.newPath as string, cwd);
          const newPath = workspace.normalize(body.newPath as string, cwd).absolute;
          response = json({ success: true, path, newPath, timestamp });
          break;
        }
        case "list": {
          const result = workspace.list(body.path as string, cwd, { recursive: !!body.recursive });
          const files = result.entries
            .map((entry) => toFileInfo(entry, path, sandboxMeta.createdAt))
            .filter((info) => body.includeHidden || !isHidden(info.relativePath));
          response = json({ success: true, path, files, count: files.length, timestamp });
          break;
        }
        case "exists": {
          const result = workspace.exists(body.path as string, cwd);
          response = json({ success: true, path, exists: result.exists, timestamp });
          break;
        }
        default:
          throw new ApiError(400, "Unknown op");
      }

      if (["write", "mkdir", "delete", "rename", "move"].includes(op)) {
        this.persistWorkspace();
      }
      await this.touchAlarm(sandboxMeta);
      return response;
    } catch (error) {
      if (error instanceof WorkspaceError) {
        // The SDK reports every failed mkdir (missing parent, existing path,
        // non-directory parent) as FILESYSTEM_ERROR, keeping the Node-style
        // code in context.errno -- everything else keeps its usual
        // errno->code mapping (errorCodeForErrno, unchanged).
        const codeOverride =
          op === "mkdir" && error.code !== "EACCES" && error.code !== "ENOSPC"
            ? ErrorCode.FILESYSTEM_ERROR
            : undefined;
        return errnoErrorResponse(
          error.code,
          error.message,
          { path: body.path as string, operation, ...error.details },
          codeOverride,
        );
      }
      throw error;
    }
  }
}
