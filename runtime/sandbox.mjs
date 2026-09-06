// createSandboxClass(engine) builds the Sandbox Durable Object class each
// language package exports (renamed from SandboxSession/createSessionClass;
// see docs/sdk-parity-design.md). A sandbox owns /workspace, cwd, the files
// API, and idle expiry exactly as the old single-REPL session did (see
// docs/sessions-design.md for those mechanics, unchanged), but the REPL
// itself is now split into named "code contexts": one sandbox can hold up to
// MAX_CONTEXTS interpreters, each with its own globals, cwd, and env, all
// sharing the one /workspace. Only one interpreter is kept resident in
// memory at a time (`this.resident`); the rest live only as their last
// snapshot until an execute() switches back to them.
import { DurableObject } from "cloudflare:workers";
import {
  ApiError,
  ErrorCode,
  errnoErrorResponse,
  errorResponse,
  MAX_CODE_BYTES,
  MAX_FILES_REQUEST_BYTES,
  MAX_REQUEST_BYTES,
} from "@sandbox-workers/core";
import { Workspace, WorkspaceError } from "./workspace.mjs";
import { PAGE_BYTES, hashMemory, diffPages } from "./snapshot.mjs";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Set by the runtime worker's fetch() before forwarding to env.SANDBOX.get(...).fetch(),
// and by @sandbox-workers/core's client when it talks to a Durable Object
// namespace binding directly: keeps the DO's own routes (below) independent
// of how the id is spelled in the public URL.
const SANDBOX_ID_HEADER = "x-sandbox-id";

const MAX_CONTEXTS = 8;

// Idle expiry (docs/sessions-design.md phase 3, unchanged). A Durable Object
// alarm is (re)armed after every request that touches a sandbox; when it
// fires (no touching request arrived in the meantime), the whole sandbox is
// deleted the same way `DELETE /sandboxes/:id` does. The TTL comes from the
// runtime Worker's own `SESSION_IDLE_TTL_MS` env var (a string, because
// Wrangler `vars` are strings): unset/invalid falls back to 24 hours, and
// `"0"` disables expiry entirely (no alarm is ever armed, and an existing one
// is cleared).
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

const FILE_OPERATION = {
  read: "file.read",
  write: "file.write",
  mkdir: "directory.create",
  delete: "file.delete",
  rename: "file.rename",
  move: "file.move",
  list: "directory.list",
  exists: "file.stat",
};

const MIME_TYPES = {
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

function json(body, init = {}) {
  return Response.json(body, { headers: { "cache-control": "no-store" }, ...init });
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

// A context's language must be the runtime language, or "typescript" when
// the runtime is javascript (the JS engine parses both dialects without a
// separate mode, so a TypeScript context is just a javascript context with a
// friendlier name at the call site) — collapsed to the runtime language
// either way. Anything else is rejected up front.
function resolveLanguage(requested, runtimeLanguage) {
  if (requested === undefined || requested === runtimeLanguage) return runtimeLanguage;
  if (runtimeLanguage === "javascript" && requested === "typescript") return runtimeLanguage;
  throw new ApiError(400, `Unsupported language '${requested}' on this runtime (${runtimeLanguage})`);
}

// Validates an envVars object: keys must be valid identifiers, values must
// be a string (sets the var) or, when `allowNull`, `null` (unsets it — the
// wire encoding of the SDK client's `undefined`, see setEnvVars in
// packages/core/src/client.ts). Returns `raw` unchanged, or undefined if
// `raw` itself is undefined.
function validateEnvVars(raw, { allowNull = false } = {}) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ApiError(400, "envVars must be an object");
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_VAR_KEY.test(key)) throw new ApiError(400, `Invalid envVars key: ${key}`);
    if (value === null && allowNull) continue;
    if (typeof value !== "string") throw new ApiError(400, "envVars values must be strings");
  }
  return raw;
}

// Execution env = sandbox envVars, then the context's own, then this call's
// — a later source overrides an earlier one, and an explicit `null` (from
// this call or a previous setEnvVars) unsets the key rather than passing the
// string "null" through to the guest.
function computeExecutionEnv(sandboxEnvVars, contextEnvVars, callEnvVars) {
  const merged = { ...sandboxEnvVars, ...contextEnvVars, ...(callEnvVars ?? {}) };
  const env = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined) continue;
    env[key] = value;
  }
  return env;
}

function validateFilesBody(body) {
  const ops = new Set(["read", "write", "mkdir", "delete", "rename", "move", "list", "exists"]);
  if (typeof body.op !== "string" || !ops.has(body.op)) throw new ApiError(400, "Unknown op");
  if (typeof body.path !== "string" || !body.path) throw new ApiError(400, "path is required");
  if ((body.op === "rename" || body.op === "move") && (typeof body.newPath !== "string" || !body.newPath))
    throw new ApiError(400, `newPath is required for ${body.op}`);
  if (body.encoding !== undefined && body.encoding !== "utf-8" && body.encoding !== "base64")
    throw new ApiError(400, "encoding must be utf-8 or base64");
}

function mimeTypeFor(path, isBinary) {
  const match = /\.[^./]+$/.exec(path);
  const type = match ? MIME_TYPES[match[0].toLowerCase()] : undefined;
  return type ?? (isBinary ? "application/octet-stream" : "text/plain");
}

function isHidden(relativePath) {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

// Maps a runtime/workspace.mjs list() entry to the SDK's FileInfo shape.
// `baseAbsolute` is the normalized directory that was listed, used to derive
// `relativePath`; directories report the sandbox's own createdAt as
// `modifiedAt` because the workspace doesn't track directory mtimes.
function toFileInfo(entry, baseAbsolute, sandboxCreatedAt) {
  const name = entry.path.split("/").pop();
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

// Shapes the stored `snapshot:<contextId>` meta record for GET /sandboxes/:id,
// per docs/sessions-design.md: `{build, pages: pageCount, bytes, takenAt, stale}`.
function snapshotInfo(snapshotMeta) {
  return {
    build: snapshotMeta.build,
    pages: snapshotMeta.pageCount,
    bytes: snapshotMeta.bytes,
    takenAt: snapshotMeta.takenAt,
    stale: !!snapshotMeta.stale,
  };
}

export function createSandboxClass(engine) {
  return class Sandbox extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.ctx = ctx;
      this.env = env;
      this.workspace = null;
      this.changesSince = undefined;
      // At most one interpreter instance is kept resident per Durable
      // Object (MAX_RESIDENT_CONTEXTS = 1): { contextId, instance,
      // prevPageHashes } for whichever context last executed, or null.
      this.resident = null;
      this.queue = Promise.resolve();
      ctx.blockConcurrencyWhile(async () => {
        await this._ensureSchema();
      });
    }

    _createTables() {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, data BLOB, updated_at INTEGER)",
      );
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS contexts (id TEXT PRIMARY KEY, value TEXT)");
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS pages (context_id TEXT, page INTEGER, data BLOB, PRIMARY KEY (context_id, page))",
      );
    }

    // A `meta` row under the old key `session`, or a `pages` table that
    // predates the context column (CREATE TABLE IF NOT EXISTS above is a
    // no-op against an existing table, so an old install's `pages` never
    // gains `context_id` on its own), means this Durable Object predates the
    // context model. There is no migration path for either — wipe and start
    // clean rather than guess at how to map one REPL onto a context.
    async _ensureSchema() {
      this._createTables();
      const legacy = [...this.ctx.storage.sql.exec("SELECT 1 FROM meta WHERE key = 'session'")].length > 0;
      const pageColumns = [...this.ctx.storage.sql.exec("PRAGMA table_info(pages)")];
      const hasContextColumn = pageColumns.some((column) => column.name === "context_id");
      if (legacy || !hasContextColumn) {
        await this.ctx.storage.deleteAll();
        this._createTables();
      }
    }

    // --- sandbox meta ---------------------------------------------------

    _loadSandboxMeta() {
      const rows = [...this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'sandbox'")];
      return rows.length ? JSON.parse(rows[0].value) : null;
    }

    _saveSandboxMeta(meta) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('sandbox', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
        JSON.stringify(meta),
      );
    }

    _ensureSandboxMeta(id) {
      let meta = this._loadSandboxMeta();
      if (!meta) {
        const now = new Date().toISOString();
        meta = {
          format: 2,
          id,
          language: engine.language,
          build: engine.build,
          createdAt: now,
          lastUsed: now,
          envVars: {},
          // Rotated implicitly on DELETE: storage is wiped, so the next
          // _ensureSandboxMeta call mints a fresh one (docs/sessions-design.md).
          lifetime: crypto.randomUUID(),
        };
        this._saveSandboxMeta(meta);
      }
      return meta;
    }

    // --- workspace --------------------------------------------------------

    _loadFiles() {
      return [...this.ctx.storage.sql.exec("SELECT path, data, updated_at FROM files")];
    }

    _ensureWorkspace() {
      if (!this.workspace) {
        this.workspace = Workspace.load(this._loadFiles());
        this.changesSince = this.workspace.changes().snapshot;
      }
      return this.workspace;
    }

    // --- contexts ---------------------------------------------------------

    _loadContextRow(id) {
      const rows = [...this.ctx.storage.sql.exec("SELECT value FROM contexts WHERE id = ?", id)];
      return rows.length ? JSON.parse(rows[0].value) : null;
    }

    _loadAllContexts() {
      return [...this.ctx.storage.sql.exec("SELECT value FROM contexts")].map((row) => JSON.parse(row.value));
    }

    _saveContext(context) {
      this.ctx.storage.sql.exec(
        "INSERT INTO contexts (id, value) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET value = ?2",
        context.id,
        JSON.stringify(context),
      );
    }

    _deleteContextRow(id) {
      this.ctx.storage.sql.exec("DELETE FROM contexts WHERE id = ?", id);
    }

    _createContextRecord({ language, cwd, envVars }) {
      if (this._loadAllContexts().length >= MAX_CONTEXTS)
        throw new ApiError(400, `Cannot create more than ${MAX_CONTEXTS} code contexts`);
      const now = new Date().toISOString();
      const context = {
        id: crypto.randomUUID(),
        language,
        cwd,
        envVars: envVars ?? {},
        createdAt: now,
        lastUsed: now,
        executions: 0,
      };
      this._saveContext(context);
      return context;
    }

    // runCode without a contextId reuses the first context (by createdAt)
    // whose language matches, creating one under /workspace when none exists
    // — the SDK's getOrCreateDefaultContext semantics, done server-side.
    _resolveDefaultContext(language) {
      const contexts = this._loadAllContexts().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const existing = contexts.find((c) => c.language === language);
      if (existing) return existing;
      return this._createContextRecord({ language, cwd: "/workspace", envVars: {} });
    }

    _deleteContext(contextId) {
      const context = this._loadContextRow(contextId);
      if (!context)
        throw new ApiError(404, `Code context '${contextId}' not found`, ErrorCode.CONTEXT_NOT_FOUND, {
          contextId,
        });
      if (this.resident?.contextId === contextId) {
        this.resident.instance.close?.();
        this.resident = null;
      }
      this._dropStoredSnapshot(contextId);
      this._deleteContextRow(contextId);
    }

    // --- per-context snapshots ---------------------------------------------

    _loadContextSnapshotMeta(contextId) {
      const rows = [
        ...this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", `snapshot:${contextId}`),
      ];
      return rows.length ? JSON.parse(rows[0].value) : null;
    }

    _saveContextSnapshotMeta(contextId, snapshot) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        `snapshot:${contextId}`,
        JSON.stringify(snapshot),
      );
    }

    // Drops a context's stored snapshot (its pages + its `snapshot:<id>` meta
    // record) — used both when a stored snapshot's `build` no longer matches
    // the current engine and when the context itself is deleted.
    _dropStoredSnapshot(contextId) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM pages WHERE context_id = ?", contextId);
        this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", `snapshot:${contextId}`);
      });
    }

    // --- resident instance --------------------------------------------------

    // Returns a live interpreter instance for `context`, reusing the
    // resident one when it already belongs to this context (and hasn't
    // trapped). Otherwise the current resident is dropped first — its state
    // is already persisted after every execute() (see _persist), so there's
    // nothing to flush — and this context is booted or restored from its own
    // snapshot rows.
    _ensureInstance(context) {
      this._ensureWorkspace();
      if (this.resident && this.resident.contextId === context.id && !this.resident.instance.invalid)
        return this.resident.instance;
      if (this.resident) {
        this.resident.instance.close?.();
        this.resident = null;
      }
      const onCwdChange = (cwd) => {
        context.cwd = cwd;
      };
      const snapshotMeta = this._loadContextSnapshotMeta(context.id);
      let instance;
      let prevPageHashes;
      if (snapshotMeta && snapshotMeta.build === engine.build) {
        // Restore: read every stored page once up front (Durable Object
        // SQLite reads are cheap — see docs/sessions-design.md's measured
        // 5 ms/16 MiB, 19 ms/64 MiB) into a plain Map so `readPage` below is
        // synchronous, matching runtime/{javascript,embedded}.mjs's restore
        // contract.
        const rows = [
          ...this.ctx.storage.sql.exec("SELECT page, data FROM pages WHERE context_id = ?", context.id),
        ];
        const byPage = new Map(
          rows.map((row) => [row.page, row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)]),
        );
        instance = engine.restore(this.workspace, context.cwd, onCwdChange, {
          // Stored as a decimal string (JSON can't carry a BigInt); see
          // runtime/protobuf.mjs's varint() which does BigInt(value)
          // internally, so passing the string straight back as `handle`
          // works unchanged.
          handle: BigInt(snapshotMeta.handle),
          extra: snapshotMeta.extra,
          memoryPages: snapshotMeta.memoryPages,
          readPage: (page) => byPage.get(page),
        });
        // The restored instance's memory isn't necessarily identical to what
        // was stored (restore only replays non-zero pages) — hash it once so
        // the next diff is exact.
        prevPageHashes = hashMemory(instance.snapshot().memory);
      } else {
        if (snapshotMeta) this._dropStoredSnapshot(context.id); // stale build: boot fresh, replay nothing
        instance = engine.boot(this.workspace, context.cwd, onCwdChange);
        prevPageHashes = new Map();
      }
      this.resident = { contextId: context.id, instance, prevPageHashes };
      return instance;
    }

    // Writes sandbox meta, the workspace file diff (if any), and — for
    // execute() — the resident context's row plus its memory page diff and
    // snapshot record, all in one transaction (docs/sessions-design.md step
    // 4, extended per context). `contextWrite` is omitted for plain file
    // operations, which are sandbox-level, not tied to any context.
    _persist(sandboxMeta, fileDiff, contextWrite) {
      const byPath = fileDiff ? new Map(this.workspace.serialize().map((f) => [f.path, f])) : null;
      this.ctx.storage.transactionSync(() => {
        if (fileDiff) {
          for (const path of fileDiff.deleted) this.ctx.storage.sql.exec("DELETE FROM files WHERE path = ?", path);
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
        if (contextWrite) {
          const { context, pageDiff, snapshotRecord } = contextWrite;
          if (pageDiff) {
            // All-zero pages (the page went back to zero, or a stale row
            // outlives a page count the current snapshot no longer reaches)
            // are deleted rather than stored.
            for (const page of pageDiff.removed)
              this.ctx.storage.sql.exec("DELETE FROM pages WHERE context_id = ?1 AND page = ?2", context.id, page);
            for (const [page, data] of pageDiff.changed) {
              this.ctx.storage.sql.exec(
                "INSERT INTO pages (context_id, page, data) VALUES (?1, ?2, ?3) ON CONFLICT(context_id, page) DO UPDATE SET data = ?3",
                context.id,
                page,
                data,
              );
            }
          }
          if (snapshotRecord) this._saveContextSnapshotMeta(context.id, snapshotRecord);
          this._saveContext(context);
        }
        this._saveSandboxMeta(sandboxMeta);
      });
    }

    // --- idle expiry ------------------------------------------------------

    _idleTtlMs() {
      const raw = this.env?.SESSION_IDLE_TTL_MS;
      if (raw === undefined || raw === null || raw === "") return DEFAULT_IDLE_TTL_MS;
      const ms = Number(raw);
      return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_IDLE_TTL_MS;
    }

    // Called after every request that touches this sandbox (everything but
    // DELETE, which has nothing left to expire). Returns the new
    // `expiresAt` timestamp, or null when expiry is disabled
    // (`SESSION_IDLE_TTL_MS` is `"0"`), in which case any previously armed
    // alarm is cleared.
    async _touchAlarm() {
      const ttl = this._idleTtlMs();
      if (ttl === 0) {
        await this.ctx.storage.deleteAlarm();
        return null;
      }
      const expiresAt = Date.now() + ttl;
      await this.ctx.storage.setAlarm(expiresAt);
      return expiresAt;
    }

    // Shared by DELETE /sandboxes/:id and the alarm handler below: wipe all
    // Durable Object storage (files, meta, contexts, pages) and drop the
    // in-memory instance/workspace so a later request starts completely
    // fresh.
    async _destroy() {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this._createTables();
      this.resident?.instance.close?.();
      this.resident = null;
      this.workspace = null;
      this.changesSince = undefined;
    }

    // Durable Object alarm handler: fires when no request has touched this
    // sandbox since the last `_touchAlarm()` call. Expiry deletes the whole
    // sandbox — same effect as a caller's `DELETE /sandboxes/:id`.
    async alarm() {
      await this._destroy();
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
        const id = request.headers.get(SANDBOX_ID_HEADER) ?? "";
        if (!ID_PATTERN.test(id)) throw new ApiError(400, "Invalid sandbox id");
        const path = new URL(request.url).pathname;
        const method = request.method;

        if (method === "DELETE" && path === "/") {
          await this._destroy();
          return json({ success: true });
        }

        const sandboxMeta = this._ensureSandboxMeta(id);

        if (method === "GET" && path === "/") return await this._info(sandboxMeta);
        if (method === "POST" && path === "/execute") return await this._execute(request, sandboxMeta);
        if (method === "POST" && path === "/contexts") return await this._createContext(request, sandboxMeta);
        if (method === "GET" && path === "/contexts") return await this._listContexts();
        const contextMatch = /^\/contexts\/([^/]+)$/.exec(path);
        if (method === "DELETE" && contextMatch) {
          this._deleteContext(decodeURIComponent(contextMatch[1]));
          await this._touchAlarm();
          return json({ success: true });
        }
        if (method === "POST" && path === "/env") return await this._setEnv(request, sandboxMeta);
        if (method === "POST" && path === "/files") return await this._files(request, sandboxMeta);

        throw new ApiError(404, "Not found", ErrorCode.VALIDATION_FAILED);
      } catch (error) {
        if (error instanceof WorkspaceError) return errnoErrorResponse(error.code, error.message, {});
        return errorResponse(error);
      }
    }

    async _info(sandboxMeta) {
      this._ensureWorkspace();
      const contexts = this._loadAllContexts().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const expiresAt = await this._touchAlarm();
      return json({
        id: sandboxMeta.id,
        language: sandboxMeta.language,
        engine: engine.engineName,
        createdAt: sandboxMeta.createdAt,
        lastUsed: sandboxMeta.lastUsed,
        envVars: sandboxMeta.envVars,
        contexts: contexts.map((context) => {
          const snapshotMeta = this._loadContextSnapshotMeta(context.id);
          return {
            id: context.id,
            language: context.language,
            cwd: context.cwd,
            createdAt: context.createdAt,
            lastUsed: context.lastUsed,
            executions: context.executions,
            snapshot: snapshotMeta ? snapshotInfo(snapshotMeta) : null,
          };
        }),
        workspace: this.workspace.stats(),
        expiresAt,
      });
    }

    async _createContext(request, sandboxMeta) {
      const body = await readJsonBody(request);
      const language = resolveLanguage(body.language, engine.language);
      let cwd = "/workspace";
      if (body.cwd !== undefined) {
        if (typeof body.cwd !== "string" || !body.cwd) throw new ApiError(400, "cwd must be a non-empty string");
        this._ensureWorkspace();
        try {
          cwd = this.workspace.normalize(body.cwd, "/workspace").absolute;
        } catch (error) {
          throw new ApiError(400, error instanceof WorkspaceError ? error.message : "Invalid cwd");
        }
      }
      const envVars = validateEnvVars(body.envVars) ?? {};
      const context = this._createContextRecord({ language, cwd, envVars });
      sandboxMeta.lastUsed = context.createdAt;
      this._saveSandboxMeta(sandboxMeta);
      await this._touchAlarm();
      return json(
        {
          id: context.id,
          language: context.language,
          cwd: context.cwd,
          createdAt: context.createdAt,
          lastUsed: context.lastUsed,
        },
        { status: 201 },
      );
    }

    async _listContexts() {
      const contexts = this._loadAllContexts().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await this._touchAlarm();
      return json({
        contexts: contexts.map((context) => ({
          id: context.id,
          language: context.language,
          cwd: context.cwd,
          createdAt: context.createdAt,
          lastUsed: context.lastUsed,
        })),
      });
    }

    async _setEnv(request, sandboxMeta) {
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
      this._saveSandboxMeta(sandboxMeta);
      await this._touchAlarm();
      return json({ success: true });
    }

    async _execute(request, sandboxMeta) {
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
      const language = resolveLanguage(body.language, engine.language);

      let context;
      if (body.contextId !== undefined) {
        context = this._loadContextRow(body.contextId);
        if (!context)
          throw new ApiError(404, `Code context '${body.contextId}' not found`, ErrorCode.CONTEXT_NOT_FOUND, {
            contextId: body.contextId,
          });
      } else {
        context = this._resolveDefaultContext(language);
      }

      const instance = this._ensureInstance(context);
      const before = this.workspace.serialize();
      const execEnv = computeExecutionEnv(sandboxMeta.envVars, context.envVars, callEnvVars);

      let result;
      let threw = false;
      try {
        result = instance.execute({ code: body.code, envVars: execEnv });
      } catch (error) {
        threw = true;
        // The JS engine throws here for a fuel-exhaustion interrupt (the
        // instance survives that — `error.trap` is not set) or the hard fuel
        // backstop (`error.trap === true`, a genuine trap: the instance does
        // NOT survive that, unlike the clean interrupt case). Anything else
        // escaping is unexpected and is treated the same as a trap.
        const limited = error?.name === "ExecutionLimitError";
        const trap = error?.trap === true;
        if ((!limited || trap) && this.resident?.contextId === context.id) this.resident = null;
        result = {
          logs: { stdout: [], stderr: [] },
          results: [],
          error: {
            name: limited ? "ExecutionLimitError" : "EngineError",
            message: String(error?.message ?? error).slice(0, 2048),
            traceback: [],
          },
          session: { cwd: context.cwd },
        };
      }

      context.executions++;
      context.lastUsed = new Date().toISOString();
      sandboxMeta.lastUsed = context.lastUsed;
      if (result.session?.cwd) context.cwd = result.session.cwd;
      delete result.session;

      // A guest-level error (result.error without a throw, e.g. an ordinary
      // Python exception) still discards this execution's workspace writes
      // in place (keeps `workspace.root`'s identity, so a still-alive
      // instance's WASI mount / host functions keep seeing the same object)
      // — but an ordinary guest exception does NOT invalidate the instance
      // or block a memory snapshot, only a trap does (handled above).
      let fileDiff = null;
      if (result.error) {
        this.workspace.restoreFrom(before);
      } else {
        fileDiff = this.workspace.changes(this.changesSince);
        this.changesSince = fileDiff.snapshot;
      }

      // Python/Perl: a trap or fuel exhaustion invalidates the instance in
      // place; drop the resident slot so the next execute in this context
      // boots fresh. JavaScript never sets this (its traps throw instead,
      // handled above).
      if (!threw && instance.invalid && this.resident?.contextId === context.id) this.resident = null;

      // Snapshot attempt: only when the instance is still resident for this
      // context (a throw either means a safe interrupt with the instance
      // kept alive — still fine to snapshot next time, nothing to do this
      // round — or a trap, which already dropped the resident above).
      let snapshotMs;
      const resident = this.resident?.contextId === context.id ? this.resident : null;
      const live = threw ? null : resident?.instance;
      if (live && live.canSnapshot()) {
        const start = performance.now();
        const snap = live.snapshot();
        const pageDiff = diffPages(snap.memory, resident.prevPageHashes);
        resident.prevPageHashes = pageDiff.hashes;
        const snapshotRecord = {
          build: engine.build,
          memoryPages: Math.round(snap.memory.buffer.byteLength / PAGE_BYTES),
          pageCount: pageDiff.hashes.size,
          bytes: pageDiff.hashes.size * PAGE_BYTES,
          // `snap.handle` is a BigInt; JSON can't serialize it -- store it as
          // a decimal string (see the matching comment in _ensureInstance).
          handle: String(snap.handle),
          extra: snap.extra,
          takenAt: Date.now(),
          stale: false,
        };
        this._persist(sandboxMeta, fileDiff, { context, pageDiff, snapshotRecord });
        snapshotMs = performance.now() - start;
      } else {
        // canSnapshot() is false (the guest still holds an open file
        // descriptor beyond the preopens): the execution result still
        // stands, but restoring the on-disk snapshot later would replay an
        // older memory image than what this execution produced. Flag it so
        // GET reports `snapshot.stale: true`.
        const existing = live ? this._loadContextSnapshotMeta(context.id) : null;
        const staleRecord = existing && !existing.stale ? { ...existing, stale: true } : null;
        this._persist(sandboxMeta, fileDiff, { context, pageDiff: null, snapshotRecord: staleRecord });
      }

      const expiresAt = await this._touchAlarm();
      return json({
        code: body.code,
        language: context.language,
        engine: engine.engineName,
        durationMs: 0,
        ...result,
        executionCount: context.executions,
        context: {
          id: context.id,
          cwd: context.cwd,
          executions: context.executions,
          ...(snapshotMs !== undefined ? { snapshotMs } : {}),
          ...(expiresAt !== null ? { expiresAt } : {}),
        },
      });
    }

    async _files(request, sandboxMeta) {
      const body = await readJsonBody(request, MAX_FILES_REQUEST_BYTES);
      validateFilesBody(body);
      this._ensureWorkspace();
      // File ops are sandbox-level, not tied to any context: they always
      // resolve relative paths against /workspace itself.
      const cwd = "/workspace";
      const timestamp = new Date().toISOString();
      const operation = FILE_OPERATION[body.op];
      try {
        const path = this.workspace.normalize(body.path, cwd).absolute;
        let response;
        switch (body.op) {
          case "read": {
            const result = this.workspace.read(body.path, cwd, { encoding: body.encoding });
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
            this.workspace.write(body.path, cwd, body.content ?? "", { encoding: body.encoding });
            response = json({ success: true, path, timestamp });
            break;
          case "mkdir":
            this.workspace.mkdir(body.path, cwd, { recursive: !!body.recursive });
            response = json({ success: true, path, recursive: !!body.recursive, timestamp });
            break;
          case "delete":
            this.workspace.delete(body.path, cwd, { recursive: !!body.recursive, force: !!body.force });
            response = json({ success: true, path, timestamp });
            break;
          case "rename":
          case "move": {
            this.workspace.rename(body.path, body.newPath, cwd);
            const newPath = this.workspace.normalize(body.newPath, cwd).absolute;
            response = json({ success: true, path, newPath, timestamp });
            break;
          }
          case "list": {
            const result = this.workspace.list(body.path, cwd, { recursive: !!body.recursive });
            const files = result.entries
              .map((entry) => toFileInfo(entry, path, sandboxMeta.createdAt))
              .filter((info) => body.includeHidden || !isHidden(info.relativePath));
            response = json({ success: true, path, files, count: files.length, timestamp });
            break;
          }
          case "exists": {
            const result = this.workspace.exists(body.path, cwd);
            response = json({ success: true, path, exists: result.exists, timestamp });
            break;
          }
        }

        if (["write", "mkdir", "delete", "rename", "move"].includes(body.op)) {
          const diff = this.workspace.changes(this.changesSince);
          this.changesSince = diff.snapshot;
          sandboxMeta.lastUsed = timestamp;
          this._persist(sandboxMeta, diff);
        }
        await this._touchAlarm();
        return response;
      } catch (error) {
        if (error instanceof WorkspaceError)
          return errnoErrorResponse(error.code, error.message, { path: body.path, operation });
        throw error;
      }
    }
  };
}
