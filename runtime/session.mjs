// createSessionClass(engine) builds the SandboxSession Durable Object class
// each language package exports. Phase 1: /workspace, cwd, the files API,
// and REPL execution kept alive in memory for as long as the Durable Object
// instance stays resident — no memory snapshot yet (phase 2). The SQLite
// schema below intentionally matches docs/sessions-design.md's storage
// layout (`meta`, `files`) so phase 2 can add the `pages` table and a
// `snapshot` key without a migration.
import { DurableObject } from "cloudflare:workers";
import {
  ApiError,
  errorResponse,
  MAX_CODE_BYTES,
  MAX_FILES_REQUEST_BYTES,
  MAX_REQUEST_BYTES,
} from "@sandbox-workers/core";
import { Workspace, WorkspaceError } from "./workspace.mjs";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Set by the worker's fetch() before forwarding to env.SESSIONS.get(...).fetch():
// keeps the DO's own routes (below) independent of how the id is spelled in
// the public URL.
const SESSION_ID_HEADER = "x-sandbox-session-id";

function json(body, init = {}) {
  return Response.json(body, { headers: { "cache-control": "no-store" }, ...init });
}

function statusForCode(code) {
  switch (code) {
    case "ENOENT":
      return 404;
    case "EEXIST":
    case "ENOTEMPTY":
      return 409;
    case "EISDIR":
    case "ENOTDIR":
      return 400;
    case "EFBIG":
    case "ENOSPC":
      return 413;
    case "EACCES":
      return 403;
    default:
      return 400;
  }
}

async function readJsonBody(request, maxBytes = MAX_REQUEST_BYTES) {
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new ApiError(413, "Request too large");
  let body;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "Expected an object");
  return body;
}

// Reuses @sandbox-workers/core's constants/ApiError for consistent limits
// and error shape, but readExecution() itself can't be reused as-is: it
// consumes the request body and only returns {language, code, envVars} — a
// session body also carries `cwd`, and a second read of the same Request
// body isn't possible.
function validateExecuteBody(body) {
  if (typeof body.code !== "string" || !body.code.trim())
    throw new ApiError(400, "Non-empty code is required");
  if (new TextEncoder().encode(body.code).length > MAX_CODE_BYTES)
    throw new ApiError(413, "Code exceeds 64 KiB");
  let envVars;
  if (body.envVars !== undefined) {
    if (typeof body.envVars !== "object" || body.envVars === null || Array.isArray(body.envVars))
      throw new ApiError(400, "envVars must be an object");
    envVars = {};
    for (const [key, raw] of Object.entries(body.envVars)) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== "string") throw new ApiError(400, "envVars values must be strings");
      if (!ENV_VAR_KEY.test(key)) continue;
      envVars[key] = raw;
    }
  }
  let cwd;
  if (body.cwd !== undefined) {
    if (typeof body.cwd !== "string" || !body.cwd) throw new ApiError(400, "cwd must be a non-empty string");
    cwd = body.cwd;
  }
  return { code: body.code, envVars, cwd };
}

function validateFilesBody(body) {
  const ops = new Set(["read", "write", "list", "delete", "rename", "mkdir", "exists", "stat"]);
  if (typeof body.op !== "string" || !ops.has(body.op)) throw new ApiError(400, "Unknown op");
  if (typeof body.path !== "string" || !body.path) throw new ApiError(400, "path is required");
  if (body.op === "rename" && (typeof body.newPath !== "string" || !body.newPath))
    throw new ApiError(400, "newPath is required for rename");
  if (body.encoding !== undefined && body.encoding !== "utf-8" && body.encoding !== "base64")
    throw new ApiError(400, "encoding must be utf-8 or base64");
  return body;
}

export function createSessionClass(engine) {
  return class SandboxSession extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.ctx = ctx;
      this.instance = null;
      this.workspace = null;
      this.changesSince = undefined;
      this.queue = Promise.resolve();
      ctx.blockConcurrencyWhile(async () => {
        this._createTables();
      });
    }

    _createTables() {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, data BLOB, updated_at INTEGER)",
      );
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    }

    // --- storage helpers ---------------------------------------------

    _loadMeta() {
      const rows = [...this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'session'")];
      return rows.length ? JSON.parse(rows[0].value) : null;
    }

    _saveMeta(meta) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('session', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
        JSON.stringify(meta),
      );
    }

    _loadFiles() {
      return [...this.ctx.storage.sql.exec("SELECT path, data, updated_at FROM files")];
    }

    _ensureMeta(id) {
      let meta = this._loadMeta();
      if (!meta) {
        const now = Date.now();
        meta = {
          id,
          language: engine.language,
          build: engine.engineName,
          cwd: "/workspace",
          createdAt: now,
          lastUsed: now,
          executions: 0,
          lifetime: crypto.randomUUID(),
        };
        this._saveMeta(meta);
      }
      return meta;
    }

    _ensureWorkspace() {
      if (!this.workspace) {
        this.workspace = Workspace.load(this._loadFiles());
        this.changesSince = this.workspace.changes().snapshot;
      }
      return this.workspace;
    }

    _ensureInstance(meta) {
      this._ensureWorkspace();
      if (this.instance && !this.instance.invalid) return this.instance;
      this.instance = engine.boot(this.workspace, meta.cwd, (cwd) => {
        meta.cwd = cwd;
      });
      return this.instance;
    }

    _persist(meta, diff) {
      const byPath = new Map(this.workspace.serialize().map((f) => [f.path, f]));
      this.ctx.storage.transactionSync(() => {
        for (const path of diff.deleted) this.ctx.storage.sql.exec("DELETE FROM files WHERE path = ?", path);
        for (const path of [...diff.created, ...diff.updated]) {
          const file = byPath.get(path);
          if (!file) continue;
          this.ctx.storage.sql.exec(
            "INSERT INTO files (path, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET data = ?2, updated_at = ?3",
            path,
            file.data,
            file.updatedAt,
          );
        }
        this._saveMeta(meta);
      });
    }

    // --- HTTP surface --------------------------------------------------

    // Requests are serialized with a promise chain: the Durable Object
    // otherwise interleaves fetch() calls at any await point, which would
    // race two executions against the same in-memory workspace/instance.
    async fetch(request) {
      const run = () => this._handle(request);
      const next = this.queue.then(run, run);
      // Keep the queue alive even if this request's handler rejects, and
      // never let one request observe another's unrelated rejection.
      this.queue = next.catch(() => {});
      return next;
    }

    async _handle(request) {
      try {
        const id = request.headers.get(SESSION_ID_HEADER) ?? "";
        if (!ID_PATTERN.test(id)) throw new ApiError(400, "Invalid session id");
        const path = new URL(request.url).pathname;

        if (request.method === "DELETE" && path === "/") {
          await this.ctx.storage.deleteAll();
          this._createTables();
          this.instance?.close?.();
          this.instance = null;
          this.workspace = null;
          this.changesSince = undefined;
          return json({ ok: true });
        }

        const meta = this._ensureMeta(id);

        if (request.method === "GET" && path === "/") {
          this._ensureWorkspace();
          return json({
            id: meta.id,
            language: meta.language,
            engine: engine.engineName,
            cwd: meta.cwd,
            createdAt: meta.createdAt,
            lastUsed: meta.lastUsed,
            executions: meta.executions,
            workspace: this.workspace.stats(),
            snapshot: null,
          });
        }

        if (request.method === "POST" && path === "/reset") {
          this._ensureWorkspace();
          this.instance?.close?.();
          this.instance = null;
          meta.lastUsed = Date.now();
          this._saveMeta(meta);
          return json({ ok: true });
        }

        if (request.method === "POST" && path === "/execute") return this._execute(request, meta);
        if (request.method === "POST" && path === "/files") return this._files(request, meta);

        throw new ApiError(404, "Not found");
      } catch (error) {
        if (error instanceof WorkspaceError) return fileErrorResponse(error);
        return errorResponse(error);
      }
    }

    async _execute(request, meta) {
      const { code, envVars, cwd } = validateExecuteBody(await readJsonBody(request));
      const instance = this._ensureInstance(meta);
      const before = this.workspace.serialize();

      let result;
      try {
        result = instance.execute({ code, envVars, cwd });
      } catch (error) {
        // Only the JS session throws here, and only for a fuel-exhaustion
        // interrupt (the instance survives that); anything else escaping is
        // unexpected, so the instance is dropped defensively.
        const limited = error?.name === "ExecutionLimitError";
        if (!limited) this.instance = null;
        result = {
          logs: { stdout: [], stderr: [] },
          results: [],
          error: {
            name: limited ? "ExecutionLimitError" : "EngineError",
            message: String(error?.message ?? error).slice(0, 2048),
            traceback: [],
          },
          session: { cwd: meta.cwd },
        };
      }

      meta.executions++;
      meta.lastUsed = Date.now();
      if (result.session?.cwd) meta.cwd = result.session.cwd;

      if (result.error) {
        // Discard this execution's workspace writes in place (keeps
        // `workspace.root`'s identity, so a still-alive instance's WASI
        // mount / host functions keep seeing the same object) and persist
        // only meta (executions/lastUsed/cwd).
        this.workspace.restoreFrom(before);
        this._saveMeta(meta);
      } else {
        const diff = this.workspace.changes(this.changesSince);
        this.changesSince = diff.snapshot;
        this._persist(meta, diff);
      }

      // Python/Perl: a trap or fuel exhaustion invalidates the instance;
      // the next call boots a fresh one. JavaScript never sets this.
      if (instance.invalid) this.instance = null;

      return json({
        code,
        language: meta.language,
        engine: engine.engineName,
        durationMs: 0,
        ...result,
        session: { id: meta.id, cwd: meta.cwd, executions: meta.executions },
      });
    }

    async _files(request, meta) {
      const body = validateFilesBody(await readJsonBody(request, MAX_FILES_REQUEST_BYTES));
      this._ensureWorkspace();
      try {
        let result;
        switch (body.op) {
          case "read":
            result = this.workspace.read(body.path, meta.cwd, { encoding: body.encoding });
            break;
          case "write":
            result = this.workspace.write(body.path, meta.cwd, body.content ?? "", {
              encoding: body.encoding,
            });
            break;
          case "list":
            result = this.workspace.list(body.path, meta.cwd, { recursive: !!body.recursive });
            break;
          case "delete":
            this.workspace.delete(body.path, meta.cwd, {
              recursive: !!body.recursive,
              force: !!body.force,
            });
            result = { ok: true };
            break;
          case "rename":
            this.workspace.rename(body.path, body.newPath, meta.cwd);
            result = { ok: true };
            break;
          case "mkdir":
            this.workspace.mkdir(body.path, meta.cwd, { recursive: !!body.recursive });
            result = { ok: true };
            break;
          case "exists":
            result = this.workspace.exists(body.path, meta.cwd);
            break;
          case "stat":
            result = this.workspace.stat(body.path, meta.cwd);
            break;
        }
        if (body.op === "write" || body.op === "delete" || body.op === "rename" || body.op === "mkdir") {
          const diff = this.workspace.changes(this.changesSince);
          this.changesSince = diff.snapshot;
          this._persist(meta, diff);
        }
        return json(result);
      } catch (error) {
        if (error instanceof WorkspaceError) return fileErrorResponse(error);
        throw error;
      }
    }
  };
}

// Workspace failures keep their Node-style code so the typed client can raise
// SandboxFileError; transport and validation failures stay ApiError.
function fileErrorResponse(error) {
  return json(
    { error: { name: "FileError", code: error.code, message: error.message } },
    { status: statusForCode(error.code) },
  );
}
