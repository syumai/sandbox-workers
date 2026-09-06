// createInterpreterClass(engine) builds the Interpreter Durable Object class
// each runtime Worker exports (renamed in place from `Sandbox`/
// createSandboxClass; see docs/sandbox-1-0-design.md). An Interpreter is
// keyed by the caller-side sandbox Durable Object's own id and owns only:
// per-context memory snapshots (the `chunks` table, unchanged from
// docs/sessions-design.md/docs/snapshot-cost-design.md) and an in-memory-only
// mirror of the sandbox's /workspace, reconciled at the top of every
// execute() from the sync payload the sandbox sends. There is no `files`
// table any more -- /workspace has exactly one source of truth, the sandbox
// Durable Object (`packages/core/src/sandbox.ts`) -- and no default-context
// resolution or per-context envVars/language: context ids are minted by the
// sandbox and passed in, and the execution env arrives flat, already merged.
import { DurableObject } from "cloudflare:workers";
import {
  ApiError,
  ErrorCode,
  errnoErrorResponse,
  errorResponse,
  MAX_CODE_BYTES,
  MAX_REQUEST_BYTES,
  MAX_SYNC_REQUEST_BYTES,
  Workspace,
  WorkspaceError,
} from "@sandbox-workers/core";
import {
  PAGE_BYTES,
  CHUNK_PAGES,
  CHUNK_BYTES,
  chunkOf,
  readChunk,
  chunksToWrite,
  hashMemory,
  diffPages,
} from "./snapshot.mjs";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// Set by the runtime worker's fetch() before forwarding
// `/interpreters/:key/...` to env.INTERPRETER.get(...).fetch() with the
// prefix stripped (see docs/sandbox-1-0-design.md, "Wire protocol: sandbox
// Durable Object -> runtime Worker").
const INTERPRETER_KEY_HEADER = "x-interpreter-key";

const MAX_CONTEXTS = 8;

// Idle expiry (docs/sessions-design.md phase 3, unchanged mechanics). A
// Durable Object alarm is (re)armed after every request that touches an
// interpreter; when it fires (no touching request arrived in the meantime),
// the whole interpreter is wiped the same way `DELETE /interpreters/:key`
// does. The TTL comes from the runtime Worker's own `INTERPRETER_IDLE_TTL_MS`
// env var (a string, because Wrangler `vars` are strings; renamed from
// `SESSION_IDLE_TTL_MS`): unset/invalid falls back to 24 hours, and `"0"`
// disables expiry entirely (no alarm is ever armed, and an existing one is
// cleared). Per docs/sandbox-1-0-design.md, this should be set to at least
// the caller's own `SANDBOX_IDLE_TTL_MS`, or a context's globals can be gone
// while the sandbox still lists it.
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

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

// envVars arrives flat and already merged (sandbox.envVars + context.envVars
// + call.envVars, computed by the sandbox -- see docs/sandbox-1-0-design.md,
// "Env vars"): plain string values only, no null/unset semantics here.
function validateEnvVars(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ApiError(400, "envVars must be an object");
  for (const value of Object.values(raw)) {
    if (typeof value !== "string") throw new ApiError(400, "envVars values must be strings");
  }
  return raw;
}

// Validates the `workspace` field of a `/execute` request (see
// docs/sandbox-1-0-design.md, "Workspace mirror and sync protocol").
function validateWorkspacePayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ApiError(400, "workspace is required");
  const { dirs, manifest, files } = raw;
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string"))
    throw new ApiError(400, "workspace.dirs must be an array of strings");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new ApiError(400, "workspace.manifest must be an object");
  for (const [path, hash] of Object.entries(manifest)) {
    if (typeof path !== "string" || typeof hash !== "string")
      throw new ApiError(400, "workspace.manifest must map string paths to string hashes");
  }
  if (!Array.isArray(files)) throw new ApiError(400, "workspace.files must be an array");
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      typeof file.data !== "string" ||
      typeof file.updatedAt !== "number"
    )
      throw new ApiError(400, "workspace.files entries must be {path, data, updatedAt}");
  }
  return { dirs, manifest, files };
}

// Builds the response `workspace` diff (docs/sandbox-1-0-design.md): `dirs`
// is always the full post-run directory list; `files`/`deleted` are empty
// when `fileDiff` is null (a guest error rolled the mirror back, so nothing
// actually changed).
function buildWorkspaceResponse(workspace, fileDiff) {
  const dirs = workspace.manifest().dirs;
  if (!fileDiff) return { dirs, files: [], deleted: [] };
  const files = [...fileDiff.created, ...fileDiff.updated].map((path) => {
    const read = workspace.read(path, "/workspace", { encoding: "base64" });
    return { path, data: read.content, updatedAt: read.updatedAt };
  });
  return { dirs, files, deleted: fileDiff.deleted };
}

// Shapes a context row's embedded `snapshot` record for the execute
// response, per docs/snapshot-cost-design.md: `{build, pages: pageCount,
// bytes, storedBytes, takenAt, stale}`. `pages`/`bytes` keep meaning live
// data (the snapshot's non-zero 64 KiB pages and their size); `storedBytes`
// is the actual on-disk footprint (`chunkCount * CHUNK_BYTES`), which is
// larger because a chunk that has any non-zero page is stored whole.
function snapshotInfo(snapshotMeta) {
  return {
    build: snapshotMeta.build,
    pages: snapshotMeta.pageCount,
    bytes: snapshotMeta.bytes,
    storedBytes: snapshotMeta.chunkCount * CHUNK_BYTES,
    takenAt: snapshotMeta.takenAt,
    stale: !!snapshotMeta.stale,
  };
}

export function createInterpreterClass(engine) {
  return class Interpreter extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.ctx = ctx;
      this.env = env;
      // In-memory only: there is no `files` table any more (see the module
      // comment above). Starts empty; the sandbox's own `sent` map is empty
      // right after an eviction too, so the next execute() for this
      // interpreter always carries a full sync payload to rebuild it.
      this.workspace = new Workspace();
      this.changesSince = undefined;
      // At most one interpreter instance is kept resident per Durable
      // Object (MAX_RESIDENT_CONTEXTS = 1): { contextId, instance,
      // prevPageHashes, chunkIds } for whichever context last executed, or
      // null. `chunkIds` is the Set<chunk> currently stored in the `chunks`
      // table for that context, maintained incrementally so `snapshot.
      // chunkCount` (see snapshotInfo/_execute) never needs an extra read.
      this.resident = null;
      // In-memory cache of the armed alarm deadline (docs/snapshot-cost-
      // design.md, "Alarm policy"); may be lost on eviction, in which case
      // _touchAlarm/alarm() fall back to storage.getAlarm().
      this.alarmAt = null;
      this.queue = Promise.resolve();
      ctx.blockConcurrencyWhile(async () => {
        await this._ensureSchema();
      });
    }

    _createTables() {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS contexts (id TEXT PRIMARY KEY, value TEXT)");
      // WITHOUT ROWID: an INSERT counts 1 row written instead of the 2 a
      // rowid table with a composite TEXT primary key costs (table + implicit
      // index) — see docs/snapshot-cost-design.md, "Problem"/"Storage layout".
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS chunks (context_id TEXT, chunk INTEGER, data BLOB, PRIMARY KEY (context_id, chunk)) WITHOUT ROWID",
      );
    }

    // Storage format 4 (docs/sandbox-1-0-design.md): the `files` table is
    // gone (the workspace mirror is in-memory only now) and the meta row
    // moves from key `sandbox` to key `interpreter`. A `files` table, a
    // `pages` table (format <= 2), a `meta` row under the old key `sandbox`
    // or `session`, or an explicit `format < 4` in `meta.interpreter` all
    // mean this Durable Object predates the current layout. There is no
    // migration -- wipe and start clean, exactly as every previous format
    // change did.
    async _ensureSchema() {
      const tableExists = (name) =>
        [
          ...this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name),
        ].length > 0;
      const hasFilesTable = tableExists("files");
      const hasPagesTable = tableExists("pages");
      const hasMetaTable = tableExists("meta");
      const legacyKey =
        hasMetaTable &&
        [...this.ctx.storage.sql.exec("SELECT 1 FROM meta WHERE key IN ('sandbox', 'session')")].length > 0;
      const interpreterRow = hasMetaTable
        ? [...this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'interpreter'")]
        : [];
      const format = interpreterRow.length ? JSON.parse(interpreterRow[0].value).format : undefined;
      const oldFormat = format !== undefined && format < 4;
      if (hasFilesTable || hasPagesTable || legacyKey || oldFormat) {
        await this.ctx.storage.deleteAll();
      }
      this._createTables();
    }

    // --- interpreter meta -------------------------------------------------

    _loadInterpreterMeta() {
      const rows = [...this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = 'interpreter'")];
      return rows.length ? JSON.parse(rows[0].value) : null;
    }

    _saveInterpreterMeta(meta) {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('interpreter', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
        JSON.stringify(meta),
      );
    }

    _ensureInterpreterMeta(key) {
      let meta = this._loadInterpreterMeta();
      if (!meta) {
        const now = new Date().toISOString();
        meta = {
          format: 4,
          key,
          build: engine.build,
          createdAt: now,
          lastUsed: now,
          // Rotated implicitly on DELETE: storage is wiped, so the next
          // _ensureInterpreterMeta call mints a fresh one.
          lifetime: crypto.randomUUID(),
        };
        this._saveInterpreterMeta(meta);
      }
      return meta;
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

    // Context ids are minted by the sandbox and passed in (no
    // crypto.randomUUID() here any more, and no language/envVars: those live
    // only on the sandbox's own context registry now).
    _createContextRecord({ id, cwd }) {
      if (this._loadAllContexts().length >= MAX_CONTEXTS)
        throw new ApiError(400, `Cannot create more than ${MAX_CONTEXTS} code contexts`);
      if (this._loadContextRow(id))
        throw new ApiError(400, `Code context '${id}' already exists`);
      const now = new Date().toISOString();
      const context = {
        id,
        cwd,
        createdAt: now,
        lastUsed: now,
        executions: 0,
        // null until the first successful snapshot; see _execute and
        // snapshotInfo (docs/snapshot-cost-design.md's folded-in record).
        snapshot: null,
      };
      this._saveContext(context);
      return context;
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
      // The row is about to be deleted outright, so there's no point
      // clearing and resaving its `snapshot` field first.
      this._dropStoredSnapshot(contextId, { saveRow: false });
      this._deleteContextRow(contextId);
    }

    // --- per-context snapshots ---------------------------------------------
    //
    // The snapshot record used to live under its own `snapshot:<contextId>`
    // meta key (docs/sessions-design.md); docs/snapshot-cost-design.md folds
    // it into the context row's own `snapshot` field instead — it was being
    // written on every execute for no reason the context row can't serve,
    // and folding it in saves a row per execute. `_loadContextRow`/
    // `_saveContext` (above) already carry it as part of the context's JSON.

    // Drops a context's stored snapshot (its chunk rows plus the embedded
    // `snapshot` field on its context row) — used both when a stored
    // snapshot's `build` no longer matches the current engine and when the
    // context itself is deleted. `saveRow: false` skips the load-and-resave
    // of the context row for callers that are about to delete or re-save it
    // themselves right after (`_deleteContext`, `_ensureInstance`'s
    // stale-build branch): saving it here too would be a wasted row write.
    // With no row read/write left to keep atomic with the DELETE, a bare
    // `.sql.exec()` (a single statement, already atomic) replaces
    // `transactionSync`.
    _dropStoredSnapshot(contextId, { saveRow = true } = {}) {
      if (!saveRow) {
        this.ctx.storage.sql.exec("DELETE FROM chunks WHERE context_id = ?", contextId);
        return;
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM chunks WHERE context_id = ?", contextId);
        const context = this._loadContextRow(contextId);
        if (context && context.snapshot) {
          context.snapshot = null;
          this._saveContext(context);
        }
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
      if (this.resident && this.resident.contextId === context.id && !this.resident.instance.invalid)
        return this.resident.instance;
      if (this.resident) {
        this.resident.instance.close?.();
        this.resident = null;
      }
      const onCwdChange = (cwd) => {
        context.cwd = cwd;
      };
      const snapshot = context.snapshot;
      let instance;
      let prevPageHashes;
      let chunkIds;
      if (snapshot && snapshot.build === engine.build) {
        // Restore: read every stored chunk once up front (Durable Object
        // SQLite reads are cheap — see docs/sessions-design.md's measured
        // 5 ms/16 MiB, 19 ms/64 MiB) into a plain Map so `readPage` below is
        // synchronous, matching runtime/{javascript,embedded}.mjs's restore
        // contract. A page with no row in its chunk's stored bytes (the
        // chunk itself has no row at all, meaning all 16 of its pages were
        // zero when the snapshot was taken) reads back as `undefined`,
        // which the restore functions already treat as "leave zero".
        const rows = [
          ...this.ctx.storage.sql.exec("SELECT chunk, data FROM chunks WHERE context_id = ?", context.id),
        ];
        const byChunk = new Map(
          rows.map((row) => [row.chunk, row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)]),
        );
        instance = engine.restore(this.workspace, context.cwd, onCwdChange, {
          // Stored as a decimal string (JSON can't carry a BigInt); see
          // runtime/protobuf.mjs's varint() which does BigInt(value)
          // internally, so passing the string straight back as `handle`
          // works unchanged.
          handle: BigInt(snapshot.handle),
          extra: snapshot.extra,
          memoryPages: snapshot.memoryPages,
          readPage: (page) => {
            const chunk = byChunk.get(chunkOf(page));
            if (!chunk) return undefined;
            const offset = (page % CHUNK_PAGES) * PAGE_BYTES;
            return chunk.subarray(offset, offset + PAGE_BYTES);
          },
        });
        // The restored instance's memory isn't necessarily identical to what
        // was stored (restore only replays non-zero pages) — hash it once so
        // the next diff is exact.
        prevPageHashes = hashMemory(instance.snapshot().memory);
        chunkIds = new Set(byChunk.keys());
      } else {
        if (snapshot) {
          // stale build: boot fresh, replay nothing. `context.snapshot` is
          // cleared in memory here and the row is saved later (by _persist,
          // once this execute() completes), so the drop itself doesn't need
          // to touch the row.
          this._dropStoredSnapshot(context.id, { saveRow: false });
          context.snapshot = null;
        }
        instance = engine.boot(this.workspace, context.cwd, onCwdChange);
        prevPageHashes = new Map();
        chunkIds = new Set();
      }
      this.resident = { contextId: context.id, instance, prevPageHashes, chunkIds };
      return instance;
    }

    // Writes the resident context's row (with its embedded snapshot record)
    // plus its memory chunk diff for execute(), and interpreter meta -- all
    // in one transaction (docs/sessions-design.md step 4, extended per
    // context and per docs/snapshot-cost-design.md's chunked write unit).
    // There is no file diff to persist any more: /workspace is in-memory
    // only here (see the module comment). `meta` is only written when the
    // caller passes one: most callers now route their `lastUsed` update
    // through the throttled `_touchAlarm` (decision 3) instead of writing it
    // here on every call.
    _persist(meta, contextWrite) {
      this.ctx.storage.transactionSync(() => {
        if (contextWrite) {
          const { context, chunkWrites, snapshotRecord } = contextWrite;
          if (chunkWrites) {
            // A chunk that went entirely back to zero is deleted rather than
            // stored (same rule format ≤ 2 applied per page).
            for (const chunk of chunkWrites.remove)
              this.ctx.storage.sql.exec("DELETE FROM chunks WHERE context_id = ?1 AND chunk = ?2", context.id, chunk);
            for (const [chunk, data] of chunkWrites.upsert) {
              this.ctx.storage.sql.exec(
                "INSERT INTO chunks (context_id, chunk, data) VALUES (?1, ?2, ?3) ON CONFLICT(context_id, chunk) DO UPDATE SET data = ?3",
                context.id,
                chunk,
                data,
              );
            }
          }
          if (snapshotRecord) context.snapshot = snapshotRecord;
          this._saveContext(context);
        }
        if (meta) this._saveInterpreterMeta(meta);
      });
    }

    // --- idle expiry ------------------------------------------------------

    _idleTtlMs() {
      const raw = this.env?.INTERPRETER_IDLE_TTL_MS;
      if (raw === undefined || raw === null || raw === "") return DEFAULT_IDLE_TTL_MS;
      const ms = Number(raw);
      return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_IDLE_TTL_MS;
    }

    // Called after every request that touches this interpreter (everything
    // but DELETE, which has nothing left to expire). Returns the armed
    // `expiresAt` deadline, or null when expiry is disabled
    // (`INTERPRETER_IDLE_TTL_MS` is `"0"`), in which case any previously
    // armed alarm is cleared.
    //
    // docs/snapshot-cost-design.md decision 3: re-arming the alarm and
    // rewriting `meta.interpreter.lastUsed` are each their own row write
    // (`setAlarm` and an UPDATE via ON CONFLICT DO UPDATE both count 1), so
    // both are throttled to only happen when the new deadline (`want`) is
    // more than `TTL / 10` later than the deadline actually armed right now
    // — an interpreter may then be wiped after as little as 0.9 x TTL of
    // inactivity instead of exactly TTL, which is documented. `this.alarmAt`
    // is an in-memory cache of the armed deadline that can be lost on
    // eviction; `storage.getAlarm()` (a read, effectively free) is the
    // fallback so the throttling decision is still correct after a cold
    // start.
    //
    // Deviation from the design doc's pseudocode: it returns `armed ?? want`,
    // which -- once any alarm has ever been armed -- returns the stale
    // `armed` value even on a call that just re-armed to `want` (`??` only
    // falls through when the left side is null/undefined, and `armed` isn't
    // once one exists). That would make `expiresAt` stop advancing after the
    // first arm. Returning `want` on the branch that actually re-arms (and
    // `armed` otherwise) is the fix that matches the doc's own comment ("the
    // deadline actually armed").
    async _touchAlarm(meta) {
      const ttl = this._idleTtlMs();
      if (ttl === 0) {
        const armed = this.alarmAt ?? (await this.ctx.storage.getAlarm());
        if (armed != null) await this.ctx.storage.deleteAlarm();
        this.alarmAt = null;
        return null;
      }
      const now = Date.now();
      const armed = this.alarmAt ?? (await this.ctx.storage.getAlarm());
      this.alarmAt = armed; // cache a cold-start storage.getAlarm() read even if we don't rearm below
      const want = now + ttl;
      if (armed == null || want - armed > ttl / 10) {
        await this.ctx.storage.setAlarm(want);
        this.alarmAt = want;
        meta.lastUsed = new Date(now).toISOString();
        this._saveInterpreterMeta(meta);
        return want; // the deadline actually armed
      }
      return armed; // unchanged: still the deadline actually armed
    }

    // Shared by DELETE /interpreters/:key and the alarm handler below: wipe
    // all Durable Object storage (meta, contexts, chunks) and drop the
    // in-memory instance/workspace so a later request starts completely
    // fresh.
    async _destroy() {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this._createTables();
      this.resident?.instance.close?.();
      this.resident = null;
      this.workspace = new Workspace();
      this.changesSince = undefined;
      this.alarmAt = null;
    }

    // Durable Object alarm handler: fires at whatever deadline was last
    // armed. Because the alarm is throttled (see _touchAlarm above), that
    // deadline can be stale by up to `TTL / 10` -- so before destroying
    // anything, re-check the real deadline computed from the persisted
    // `lastUsed` and, if activity since the last arm pushed it into the
    // future, re-arm to that time instead of expiring early
    // (docs/snapshot-cost-design.md, "Alarm policy").
    async alarm() {
      const meta = this._loadInterpreterMeta();
      const ttl = this._idleTtlMs();
      if (meta == null || ttl === 0) return;
      const deadline = Date.parse(meta.lastUsed) + ttl;
      if (deadline > Date.now()) {
        await this.ctx.storage.setAlarm(deadline);
        this.alarmAt = deadline;
        return;
      }
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
        const key = request.headers.get(INTERPRETER_KEY_HEADER) ?? "";
        if (!ID_PATTERN.test(key)) throw new ApiError(400, "Invalid interpreter key");
        const path = new URL(request.url).pathname;
        const method = request.method;

        if (method === "DELETE" && path === "/") {
          await this._destroy();
          return json({ success: true });
        }

        const meta = this._ensureInterpreterMeta(key);

        if (method === "POST" && path === "/contexts") return await this._createContext(request, meta);
        const contextMatch = /^\/contexts\/([^/]+)$/.exec(path);
        if (method === "DELETE" && contextMatch) {
          this._deleteContext(decodeURIComponent(contextMatch[1]));
          await this._touchAlarm(meta);
          return json({ success: true });
        }
        if (method === "POST" && path === "/execute") return await this._execute(request, meta);

        throw new ApiError(404, "Not found", ErrorCode.VALIDATION_FAILED);
      } catch (error) {
        if (error instanceof WorkspaceError) return errnoErrorResponse(error.code, error.message, {});
        return errorResponse(error);
      }
    }

    async _createContext(request, meta) {
      const body = await readJsonBody(request);
      if (typeof body.id !== "string" || !body.id || body.id.length > 128)
        throw new ApiError(400, "id must be a non-empty string of at most 128 characters");
      let cwd = "/workspace";
      if (body.cwd !== undefined) {
        if (typeof body.cwd !== "string" || !body.cwd) throw new ApiError(400, "cwd must be a non-empty string");
        try {
          cwd = this.workspace.normalize(body.cwd, "/workspace").absolute;
        } catch (error) {
          throw new ApiError(400, error instanceof WorkspaceError ? error.message : "Invalid cwd");
        }
      }
      const context = this._createContextRecord({ id: body.id, cwd });
      await this._touchAlarm(meta);
      return json({ id: context.id, cwd: context.cwd, createdAt: context.createdAt }, { status: 201 });
    }

    async _execute(request, meta) {
      const body = await readJsonBody(request, MAX_SYNC_REQUEST_BYTES);
      if (typeof body.code !== "string" || !body.code.trim())
        throw new ApiError(400, "Non-empty code is required");
      if (new TextEncoder().encode(body.code).length > MAX_CODE_BYTES)
        throw new ApiError(413, "Code exceeds 64 KiB");
      const envVars = validateEnvVars(body.envVars) ?? {};
      if (typeof body.contextId !== "string" || !body.contextId)
        throw new ApiError(400, "contextId must be a non-empty string");
      const workspacePayload = validateWorkspacePayload(body.workspace);

      const context = this._loadContextRow(body.contextId);
      if (!context)
        throw new ApiError(404, `Code context '${body.contextId}' not found`, ErrorCode.CONTEXT_NOT_FOUND, {
          contextId: body.contextId,
        });

      // Reconcile the mirror before running anything (docs/sandbox-1-0-
      // design.md, "Workspace mirror and sync protocol"): create dirs, write
      // files, delete what's no longer wanted. If the mirror still doesn't
      // match the manifest afterwards (this interpreter was evicted, or the
      // sandbox's own idea of what it holds was stale), answer `resync`
      // instead of executing; the sandbox retries once with the missing
      // files added.
      const { missing } = this.workspace.applySync({
        dirs: workspacePayload.dirs,
        files: workspacePayload.files,
        manifest: workspacePayload.manifest,
      });
      if (missing.length > 0) {
        await this._touchAlarm(meta);
        return json({ resync: true, missing });
      }
      // The response `workspace` diff is taken from right after
      // reconciliation, not from whatever this context's mirror looked like
      // before -- reconciliation itself is not "this execution's changes".
      this.changesSince = this.workspace.changes().snapshot;

      const instance = this._ensureInstance(context);
      const before = this.workspace.serialize();

      let result;
      let threw = false;
      try {
        result = instance.execute({ code: body.code, envVars });
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
      // meta.lastUsed is no longer set here: it now goes through the
      // throttled _touchAlarm below (docs/snapshot-cost-design.md decision
      // 3), which writes it only when the alarm actually re-arms. The
      // context row above still gets an exact lastUsed on every execute.
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
        const memoryPages = Math.round(snap.memory.buffer.byteLength / PAGE_BYTES);
        const pageDiff = diffPages(snap.memory, resident.prevPageHashes);
        resident.prevPageHashes = pageDiff.hashes;
        // Page diff -> chunk writes (docs/snapshot-cost-design.md decision
        // 1): only the chunks containing a changed or removed page are
        // touched, and `resident.chunkIds` (the running set of chunks
        // actually stored for this context) is updated incrementally so
        // `chunkCount` below never needs its own read.
        const { upsert, remove } = chunksToWrite(pageDiff, pageDiff.hashes);
        for (const chunk of remove) resident.chunkIds.delete(chunk);
        for (const chunk of upsert) resident.chunkIds.add(chunk);
        const chunkWrites = {
          upsert: upsert.map((chunk) => [chunk, readChunk(snap.memory, chunk, memoryPages)]),
          remove,
        };
        const snapshotRecord = {
          build: engine.build,
          memoryPages,
          pageCount: pageDiff.hashes.size,
          bytes: pageDiff.hashes.size * PAGE_BYTES,
          // Storage footprint, not live-data size (see snapshotInfo): a
          // chunk with any non-zero page is stored whole.
          chunkCount: resident.chunkIds.size,
          // `snap.handle` is a BigInt; JSON can't serialize it -- store it as
          // a decimal string (see the matching comment in _ensureInstance).
          handle: String(snap.handle),
          extra: snap.extra,
          takenAt: Date.now(),
          stale: false,
        };
        this._persist(null, { context, chunkWrites, snapshotRecord });
        snapshotMs = performance.now() - start;
      } else {
        // canSnapshot() is false (the guest still holds an open file
        // descriptor beyond the preopens): the execution result still
        // stands, but restoring the on-disk snapshot later would replay an
        // older memory image than what this execution produced. Flag it so
        // the response's `context.snapshot.stale` is true.
        const existing = live ? context.snapshot : null;
        const staleRecord = existing && !existing.stale ? { ...existing, stale: true } : null;
        this._persist(null, { context, chunkWrites: null, snapshotRecord: staleRecord });
      }

      await this._touchAlarm(meta);
      return json({
        code: body.code,
        // ExecutionResult.language/engine are the runtime's own.
        language: engine.language,
        engine: engine.engineName,
        durationMs: 0,
        ...result,
        executionCount: context.executions,
        context: {
          id: context.id,
          cwd: context.cwd,
          executions: context.executions,
          ...(snapshotMs !== undefined ? { snapshotMs } : {}),
          snapshot: context.snapshot ? snapshotInfo(context.snapshot) : null,
        },
        workspace: buildWorkspaceResponse(this.workspace, fileDiff),
      });
    }
  };
}
