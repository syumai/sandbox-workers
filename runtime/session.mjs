// createSessionClass(engine) builds the SandboxSession Durable Object class
// each language package exports. Phase 1 built /workspace, cwd, the files
// API, and REPL execution kept alive in memory only for as long as the
// Durable Object instance stayed resident. Phase 2 (this file) adds memory
// snapshots: the `pages` table and a `snapshot` meta record, so a session
// survives eviction, hibernation, and redeploys (as long as the engine
// `build` hasn't changed) — see docs/sessions-design.md "Durable Object" and
// "Snapshot rules". `engine` additionally provides `build` (a sha256 of the
// metered engine.wasm, used to guard restores) and `restore(workspace, cwd,
// onCwdChange, snapshot)`.
import { DurableObject } from "cloudflare:workers";
import {
  ApiError,
  errorResponse,
  MAX_CODE_BYTES,
  MAX_FILES_REQUEST_BYTES,
  MAX_REQUEST_BYTES,
} from "@sandbox-workers/core";
import { Workspace, WorkspaceError } from "./workspace.mjs";
import { PAGE_BYTES, hashMemory, diffPages } from "./snapshot.mjs";

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
      // Page hashes for the live `this.instance`'s memory as of the last
      // snapshot write (or, right after a restore, as of the restored
      // memory itself — see _ensureInstance). Kept in memory only; the
      // Durable Object never needs to persist hashes, only page bytes.
      this.prevPageHashes = new Map();
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
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pages (page INTEGER PRIMARY KEY, data BLOB)");
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

    _loadSnapshotMeta() {
      const rows = [...this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'snapshot'")];
      return rows.length ? JSON.parse(rows[0].value) : null;
    }

    _saveSnapshotMeta(snapshot) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('snapshot', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
        JSON.stringify(snapshot),
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
          build: engine.build,
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

    // Drops any stored snapshot (pages + the `snapshot` meta record) — used
    // both when a stored snapshot's `build` no longer matches the current
    // engine (below) and by POST /reset.
    _dropStoredSnapshot() {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM pages");
        this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'snapshot'");
      });
    }

    _ensureInstance(meta) {
      this._ensureWorkspace();
      if (this.instance && !this.instance.invalid) return this.instance;
      const onCwdChange = (cwd) => {
        meta.cwd = cwd;
      };
      const snapshotMeta = this._loadSnapshotMeta();
      if (snapshotMeta && snapshotMeta.build === engine.build) {
        // Restore: read every stored page once up front (Durable Object
        // SQLite reads are cheap — see docs/sessions-design.md's measured
        // 5 ms/16 MiB, 19 ms/64 MiB) into a plain Map so `readPage` below is
        // synchronous, matching runtime/{javascript,embedded}.mjs's restore
        // contract.
        const rows = [...this.ctx.storage.sql.exec("SELECT page, data FROM pages")];
        const byPage = new Map(
          rows.map((row) => [row.page, row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)]),
        );
        this.instance = engine.restore(this.workspace, meta.cwd, onCwdChange, {
          // Stored as a decimal string (see _persist's snapshotRecord.handle
          // comment) because JSON can't carry a BigInt; convert back here
          // rather than in the runtime modules, because runtime/protobuf.mjs's
          // message() encodes a field as a length-delimited STRING whenever
          // typeof value === "string" -- passing the stored string straight
          // through as `handle` would silently send the wrong wire type to
          // the engine instead of the varint it expects.
          handle: BigInt(snapshotMeta.handle),
          extra: snapshotMeta.extra,
          memoryPages: snapshotMeta.memoryPages,
          readPage: (page) => byPage.get(page),
        });
        // The restored instance's memory isn't necessarily identical to what
        // was stored (restore only replays non-zero pages; freshly grown
        // regions are already zero) — hash it once so the next diff is
        // exact, rather than assuming byPage's keys are the full picture.
        this.prevPageHashes = hashMemory(this.instance.snapshot().memory);
      } else {
        if (snapshotMeta) this._dropStoredSnapshot(); // stale build: boot fresh, replay nothing
        this.instance = engine.boot(this.workspace, meta.cwd, onCwdChange);
        this.prevPageHashes = new Map();
      }
      return this.instance;
    }

    // Writes meta, the workspace file diff (if any), and the memory page
    // diff (if any) in one transaction, matching docs/sessions-design.md
    // step 4: "write meta, changed files, and changed pages in one
    // transaction". `fileDiff` is null when the execution failed (its
    // workspace writes were already discarded by the caller); `pageDiff` is
    // null when the instance can't be snapshotted this round.
    _persist(meta, fileDiff, pageDiff, snapshotRecord) {
      const byPath = fileDiff ? new Map(this.workspace.serialize().map((f) => [f.path, f])) : null;
      this.ctx.storage.transactionSync(() => {
        if (fileDiff) {
          for (const path of fileDiff.deleted)
            this.ctx.storage.sql.exec("DELETE FROM files WHERE path = ?", path);
          for (const path of [...fileDiff.created, ...fileDiff.updated]) {
            const file = byPath.get(path);
            if (!file) continue;
            this.ctx.storage.sql.exec(
              "INSERT INTO files (path, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET data = ?2, updated_at = ?3",
              path,
              file.data,
              file.updatedAt,
            );
          }
        }
        if (pageDiff) {
          // All-zero pages (the page went back to zero, or a stale row
          // outlives a page count the current snapshot no longer reaches)
          // are deleted rather than stored, per docs/sessions-design.md.
          for (const page of pageDiff.removed) this.ctx.storage.sql.exec("DELETE FROM pages WHERE page = ?", page);
          for (const [page, data] of pageDiff.changed) {
            this.ctx.storage.sql.exec(
              "INSERT INTO pages (page, data) VALUES (?1, ?2) ON CONFLICT(page) DO UPDATE SET data = ?2",
              page,
              data,
            );
          }
        }
        // Separate from `pageDiff` so the "mark the existing snapshot
        // stale" path (no page bytes to write, just flip one flag) can share
        // this same transaction with the meta/file writes above.
        if (snapshotRecord) this._saveSnapshotMeta(snapshotRecord);
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
          this.prevPageHashes = new Map();
          return json({ ok: true });
        }

        const meta = this._ensureMeta(id);

        if (request.method === "GET" && path === "/") {
          this._ensureWorkspace();
          const snapshotMeta = this._loadSnapshotMeta();
          return json({
            id: meta.id,
            language: meta.language,
            engine: engine.engineName,
            cwd: meta.cwd,
            createdAt: meta.createdAt,
            lastUsed: meta.lastUsed,
            executions: meta.executions,
            workspace: this.workspace.stats(),
            snapshot: snapshotMeta ? snapshotInfo(snapshotMeta) : null,
          });
        }

        if (request.method === "POST" && path === "/reset") {
          this._ensureWorkspace();
          this.instance?.close?.();
          this.instance = null;
          this.prevPageHashes = new Map();
          this._dropStoredSnapshot();
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
      let threw = false;
      try {
        result = instance.execute({ code, envVars, cwd });
      } catch (error) {
        threw = true;
        // The JS session throws here for a fuel-exhaustion interrupt (the
        // instance survives that — `error.trap` is not set) or the hard
        // fuel backstop (`error.trap === true`, a genuine trap: the instance
        // does NOT survive that, unlike the clean interrupt case). Anything
        // else escaping is unexpected and is treated the same as a trap.
        const limited = error?.name === "ExecutionLimitError";
        const trap = error?.trap === true;
        if (!limited || trap) this.instance = null;
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

      // A guest-level error (result.error without a throw, e.g. an ordinary
      // Python exception) still discards this execution's workspace writes
      // in place (keeps `workspace.root`'s identity, so a still-alive
      // instance's WASI mount / host functions keep seeing the same object)
      // — but per docs/sessions-design.md, an ordinary guest exception does
      // NOT invalidate the instance or block a memory snapshot, only a trap
      // does (handled above by dropping `this.instance`).
      let fileDiff = null;
      if (result.error) {
        this.workspace.restoreFrom(before);
      } else {
        fileDiff = this.workspace.changes(this.changesSince);
        this.changesSince = fileDiff.snapshot;
      }

      // Python/Perl: a trap or fuel exhaustion invalidates the instance;
      // the next call boots a fresh one. JavaScript never sets this (its
      // traps throw instead, handled above).
      if (!threw && instance.invalid) this.instance = null;

      // Snapshot attempt: only when instance.execute() didn't throw (a
      // throw either means a safe interrupt with the instance kept alive —
      // still fine to snapshot next time, nothing to do this round — or a
      // trap, which already dropped `this.instance` above so there is
      // nothing left to snapshot).
      let snapshotMs;
      const live = threw ? null : this.instance;
      if (live && live.canSnapshot()) {
        const start = performance.now();
        const snap = live.snapshot();
        const pageDiff = diffPages(snap.memory, this.prevPageHashes);
        this.prevPageHashes = pageDiff.hashes;
        const snapshotRecord = {
          build: engine.build,
          memoryPages: Math.round(snap.memory.buffer.byteLength / PAGE_BYTES),
          pageCount: pageDiff.hashes.size,
          bytes: pageDiff.hashes.size * PAGE_BYTES,
          // `snap.handle` is a BigInt (runtime/protobuf.mjs decodes every
          // protobuf varint field as one), which JSON.stringify can't
          // serialize -- store it as a decimal string. protobuf.mjs's
          // varint() does `BigInt(value)` internally, so passing this string
          // straight back as `snapshot.handle` on restore works unchanged.
          handle: String(snap.handle),
          extra: snap.extra,
          takenAt: Date.now(),
          stale: false,
        };
        this._persist(meta, fileDiff, pageDiff, snapshotRecord);
        snapshotMs = performance.now() - start;
      } else {
        // canSnapshot() is false (the guest still holds an open file
        // descriptor beyond the preopens): the execution result still
        // stands, but restoring the on-disk snapshot later would replay an
        // older memory image than what this execution produced. Flag it so
        // GET reports `snapshot.stale: true` (see docs), in the same
        // transaction as the meta/file writes below.
        const existing = live ? this._loadSnapshotMeta() : null;
        const staleRecord = existing && !existing.stale ? { ...existing, stale: true } : null;
        this._persist(meta, fileDiff, null, staleRecord);
      }

      return json({
        code,
        language: meta.language,
        engine: engine.engineName,
        durationMs: 0,
        ...result,
        session: {
          id: meta.id,
          cwd: meta.cwd,
          executions: meta.executions,
          ...(snapshotMs !== undefined ? { snapshotMs } : {}),
        },
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

// Shapes the stored `snapshot` meta record for GET /sessions/:id, per
// docs/sessions-design.md: `{build, pages: pageCount, bytes, takenAt, stale}`.
function snapshotInfo(snapshotMeta) {
  return {
    build: snapshotMeta.build,
    pages: snapshotMeta.pageCount,
    bytes: snapshotMeta.bytes,
    takenAt: snapshotMeta.takenAt,
    stale: !!snapshotMeta.stale,
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
