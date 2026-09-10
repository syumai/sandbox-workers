// InterpreterServer: the plain-class body of the Interpreter Durable Object
// every runtime Worker exports (TypeScript port of
// `createInterpreterClass(engine)` in the pre-split `runtime/interpreter.mjs`
// -- see docs/sandbox-1-0-design.md and tmp/interpreter-core-split-design.md
// section 5.2). An Interpreter is keyed by the caller-side sandbox Durable
// Object's own id and owns only: per-context memory snapshots (the `chunks`
// table, unchanged from docs/sessions-design.md/docs/snapshot-cost-design.md)
// and an in-memory-only mirror of the sandbox's /workspace, reconciled at the
// top of every executeInContext() call: the sandbox sends a manifest of the
// workspace's shape (dirs + file hashes, no contents) over Workers RPC, and
// the interpreter pulls whatever content it's missing by calling back the
// `getFiles` stub the sandbox passed as an RPC argument -- there is no push
// and no HTTP resync handshake (see docs/sandbox-1-0-design.md, "Workspace
// mirror and sync protocol"). There is no `files` table -- /workspace has
// exactly one source of truth, the sandbox Durable Object
// (`packages/core/src/sandbox.ts`) -- and no default-context resolution or
// per-context envVars/language: context ids are minted by the sandbox and
// passed in, and the execution env arrives flat, already merged.
//
// `InterpreterServer` is a plain class -- like core's `Sandbox` -- so it can
// be driven from Node against a fake `DurableObjectStateLike` (see
// `./testing.ts`). `InterpreterDurableObject` (`./durable-object.ts`) is the
// thin `cloudflare:workers` `DurableObject` wrapper that constructs one of
// these and delegates to it.
import {
  ApiError,
  DEFAULT_IDLE_TTL_MS,
  ErrorCode,
  IdleAlarm,
  INTERPRETER_KEY_HEADER,
  INTERPRETER_KEY_PATTERN,
  MAX_CODE_BYTES,
  MAX_CONTEXTS,
  MAX_REQUEST_BYTES,
  Workspace,
  WorkspaceError,
  errnoErrorBody,
  errnoErrorResponse,
  errorBody,
  errorResponse,
  parseIdleTtlMs,
  validateEnvVarsObject,
  type DurableObjectStateLike,
  type GetWorkspaceFiles,
  type InterpreterExecuteArgs,
  type InterpreterExecuteResponse,
  type InterpreterExecuteRpcResult,
  type WorkspaceFileEntry,
} from "@sandbox-workers/core";
import { engineErrorOutcome } from "./envelope.js";
import type { Engine, SessionInstance, SessionOutcome } from "./engine.js";
import {
  CHUNK_BYTES,
  CHUNK_PAGES,
  PAGE_BYTES,
  chunkOf,
  chunksToWrite,
  diffPages,
  hashMemory,
  readChunk,
} from "./snapshot.js";

/** Env `InterpreterServer` reads from directly (every other binding belongs to the Engine). */
export interface InterpreterEnv {
  /**
   * Idle expiry TTL in milliseconds, as a string (Wrangler `vars` are
   * strings). Unset/invalid falls back to 24 hours; `"0"` disables expiry
   * entirely. Per docs/sandbox-1-0-design.md, this should be set to at
   * least the caller's own `SANDBOX_IDLE_TTL_MS`, or a context's globals can
   * be gone while the sandbox still lists it.
   */
  INTERPRETER_IDLE_TTL_MS?: string;
}

interface InterpreterMeta {
  format: 4;
  key: string;
  build: string;
  createdAt: string;
  lastUsed: string;
  /** Rotated implicitly on DELETE: storage is wiped, so the next ensureInterpreterMeta call mints a fresh one. */
  lifetime: string;
}

/**
 * Shapes a context row's embedded `snapshot` record, per
 * docs/snapshot-cost-design.md: `pages`/`bytes` keep meaning live data (the
 * snapshot's non-zero 64 KiB pages and their size); `storedBytes` is the
 * actual on-disk footprint (`chunkCount * CHUNK_BYTES`), larger because a
 * chunk with any non-zero page is stored whole.
 */
interface SnapshotRecord {
  build: string;
  memoryPages: number;
  pageCount: number;
  bytes: number;
  chunkCount: number;
  /** A decimal string: JSON can't carry a BigInt (see `SessionSnapshotSource.handle`). */
  handle: string;
  extra: Record<string, unknown>;
  takenAt: number;
  stale: boolean;
}

interface ContextRow {
  id: string;
  cwd: string;
  createdAt: string;
  lastUsed: string;
  executions: number;
  /** null until the first successful snapshot. */
  snapshot: SnapshotRecord | null;
}

/**
 * At most one interpreter instance is kept resident per Durable Object
 * (MAX_RESIDENT_CONTEXTS = 1): whichever context last executed, or null.
 * `chunkIds` is the Set<chunk> currently stored in the `chunks` table for
 * that context, maintained incrementally so a snapshot record's
 * `chunkCount` never needs an extra read.
 */
interface Resident {
  contextId: string;
  instance: SessionInstance;
  prevPageHashes: Map<number, number>;
  chunkIds: Set<number>;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" }, ...init });
}

async function readJsonBody(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new ApiError(413, "Request too large");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Expected an object");
  return body as Record<string, unknown>;
}

/**
 * Validates the `workspace` field of an `executeInContext` RPC call (see
 * docs/sandbox-1-0-design.md, "Workspace mirror and sync protocol"): the
 * shape of /workspace only, no contents -- those are pulled separately via
 * `getFiles` -- plus the `disabled` flag that gates all guest access to
 * /workspace for this execution (see `Workspace.disabled`).
 */
function validateWorkspaceManifest(raw: unknown): { dirs: string[]; manifest: Record<string, string>; disabled: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError(400, "workspace is required");
  const { dirs, manifest, disabled } = raw as Record<string, unknown>;
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string"))
    throw new ApiError(400, "workspace.dirs must be an array of strings");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new ApiError(400, "workspace.manifest must be an object");
  for (const [path, hash] of Object.entries(manifest as Record<string, unknown>)) {
    if (typeof path !== "string" || typeof hash !== "string")
      throw new ApiError(400, "workspace.manifest must map string paths to string hashes");
  }
  if (disabled !== undefined && typeof disabled !== "boolean")
    throw new ApiError(400, "workspace.disabled must be a boolean");
  return { dirs, manifest: manifest as Record<string, string>, disabled: disabled === true };
}

/**
 * Validates what `getFiles(missing)` returned: an array of
 * `{ path, data, updatedAt }` entries, `data` a `Uint8Array` (the RPC wire
 * format carries raw bytes, not base64), and `path` one of the paths that
 * were actually requested -- the interpreter never trusts the sandbox to
 * answer only what was asked, but an entry for anything else would still be
 * silently wrong to apply.
 */
function validatePulledFiles(pulled: unknown, requested: string[]): asserts pulled is WorkspaceFileEntry[] {
  if (!Array.isArray(pulled))
    throw new ApiError(500, "Sandbox returned an invalid workspace file list", ErrorCode.INTERNAL_ERROR);
  const allowed = new Set(requested);
  for (const entry of pulled) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !(entry.data instanceof Uint8Array) ||
      typeof entry.updatedAt !== "number" ||
      !allowed.has(entry.path)
    )
      throw new ApiError(500, "Sandbox returned an invalid workspace file entry", ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Builds the response `workspace` diff (docs/sandbox-1-0-design.md): `dirs`
 * is always the full post-run directory list; `files`/`deleted` are empty
 * when `fileDiff` is null (a guest error rolled the mirror back, so nothing
 * actually changed).
 */
function buildWorkspaceResponse(
  workspace: Workspace,
  fileDiff: { created: string[]; updated: string[]; deleted: string[] } | null,
): InterpreterExecuteResponse["workspace"] {
  const dirs = workspace.manifest().dirs;
  if (!fileDiff) return { dirs, files: [], deleted: [] };
  const files = [...fileDiff.created, ...fileDiff.updated].map((path) => {
    const { data, updatedAt } = workspace.readBytes(path, "/workspace");
    return { path, data, updatedAt };
  });
  return { dirs, files, deleted: fileDiff.deleted };
}

function snapshotInfo(snapshotMeta: SnapshotRecord): InterpreterExecuteResponse["context"]["snapshot"] {
  return {
    build: snapshotMeta.build,
    pages: snapshotMeta.pageCount,
    bytes: snapshotMeta.bytes,
    storedBytes: snapshotMeta.chunkCount * CHUNK_BYTES,
    takenAt: snapshotMeta.takenAt,
    stale: !!snapshotMeta.stale,
  };
}

export class InterpreterServer {
  private workspace: Workspace;
  /** At most one interpreter instance is kept resident per Durable Object. */
  private resident: Resident | null = null;
  private readonly idleAlarm: IdleAlarm;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectStateLike,
    private readonly env: InterpreterEnv,
    /**
     * A getter, not a value: the Durable Object wrapper (`InterpreterDurableObject`)
     * constructs `InterpreterServer` inside its own constructor, before the
     * subclass's `engine` field is initialized. Nothing in the constructor
     * (schema setup, via `blockConcurrencyWhile`) touches the engine, so this
     * is only ever called from `fetch`/`executeInContext`/`alarm`.
     */
    private readonly getEngine: () => Engine,
  ) {
    // In-memory only: there is no `files` table (see the module comment
    // above). Starts empty; the sandbox's own "sent" map is empty right
    // after an eviction too, so the next execute() for this interpreter
    // always carries a full sync payload to rebuild it.
    this.workspace = new Workspace();
    this.idleAlarm = new IdleAlarm(state.storage, parseIdleTtlMs(env?.INTERPRETER_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS));
    state.blockConcurrencyWhile(() => this.ensureSchema());
  }

  private get engine(): Engine {
    return this.getEngine();
  }

  private createTables(): void {
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS contexts (id TEXT PRIMARY KEY, value TEXT)");
    // WITHOUT ROWID: an INSERT counts 1 row written instead of the 2 a
    // rowid table with a composite TEXT primary key costs (table + implicit
    // index) -- see docs/snapshot-cost-design.md, "Problem"/"Storage layout".
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS chunks (context_id TEXT, chunk INTEGER, data BLOB, PRIMARY KEY (context_id, chunk)) WITHOUT ROWID",
    );
  }

  // Storage format 4 (docs/sandbox-1-0-design.md): the `files` table is gone
  // (the workspace mirror is in-memory only) and the meta row moves from key
  // `sandbox` to key `interpreter`. A `files` table, a `pages` table
  // (format <= 2), a `meta` row under the old key `sandbox` or `session`, or
  // an explicit `format < 4` in `meta.interpreter` all mean this Durable
  // Object predates the current layout. There is no migration -- wipe and
  // start clean, exactly as every previous format change did.
  private async ensureSchema(): Promise<void> {
    const tableExists = (name: string): boolean =>
      [...this.state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name)].length >
      0;
    const hasFilesTable = tableExists("files");
    const hasPagesTable = tableExists("pages");
    const hasMetaTable = tableExists("meta");
    const legacyKey =
      hasMetaTable &&
      [...this.state.storage.sql.exec("SELECT 1 FROM meta WHERE key IN ('sandbox', 'session')")].length > 0;
    const interpreterRow = hasMetaTable
      ? [...this.state.storage.sql.exec("SELECT value FROM meta WHERE key = 'interpreter'")]
      : [];
    const format = interpreterRow.length
      ? (JSON.parse((interpreterRow[0] as { value: string }).value).format as number | undefined)
      : undefined;
    const oldFormat = format !== undefined && format < 4;
    if (hasFilesTable || hasPagesTable || legacyKey || oldFormat) {
      await this.state.storage.deleteAll();
    }
    this.createTables();
  }

  // --- interpreter meta ---------------------------------------------------

  private loadInterpreterMeta(): InterpreterMeta | null {
    const rows = [...this.state.storage.sql.exec("SELECT value FROM meta WHERE key = 'interpreter'")];
    return rows.length ? JSON.parse((rows[0] as { value: string }).value) : null;
  }

  private saveInterpreterMeta(meta: InterpreterMeta): void {
    this.state.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('interpreter', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
      JSON.stringify(meta),
    );
  }

  private ensureInterpreterMeta(key: string): InterpreterMeta {
    let meta = this.loadInterpreterMeta();
    if (!meta) {
      const now = new Date().toISOString();
      meta = {
        format: 4,
        key,
        build: this.engine.build,
        createdAt: now,
        lastUsed: now,
        lifetime: crypto.randomUUID(),
      };
      this.saveInterpreterMeta(meta);
    }
    return meta;
  }

  // --- contexts ------------------------------------------------------------

  private loadContextRow(id: string): ContextRow | null {
    const rows = [...this.state.storage.sql.exec("SELECT value FROM contexts WHERE id = ?", id)];
    return rows.length ? JSON.parse((rows[0] as { value: string }).value) : null;
  }

  private loadAllContexts(): ContextRow[] {
    return [...this.state.storage.sql.exec("SELECT value FROM contexts")].map((row) =>
      JSON.parse((row as { value: string }).value),
    );
  }

  private saveContext(context: ContextRow): void {
    this.state.storage.sql.exec(
      "INSERT INTO contexts (id, value) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET value = ?2",
      context.id,
      JSON.stringify(context),
    );
  }

  private deleteContextRow(id: string): void {
    this.state.storage.sql.exec("DELETE FROM contexts WHERE id = ?", id);
  }

  // Context ids are minted by the sandbox and passed in -- no
  // crypto.randomUUID() here, and no language/envVars: those live only on
  // the sandbox's own context registry.
  private createContextRecord({ id, cwd }: { id: string; cwd: string }): ContextRow {
    if (this.loadAllContexts().length >= MAX_CONTEXTS)
      throw new ApiError(400, `Cannot create more than ${MAX_CONTEXTS} code contexts`);
    if (this.loadContextRow(id)) throw new ApiError(400, `Code context '${id}' already exists`);
    const now = new Date().toISOString();
    const context: ContextRow = { id, cwd, createdAt: now, lastUsed: now, executions: 0, snapshot: null };
    this.saveContext(context);
    return context;
  }

  private deleteContext(contextId: string): void {
    const context = this.loadContextRow(contextId);
    if (!context)
      throw new ApiError(404, `Code context '${contextId}' not found`, ErrorCode.CONTEXT_NOT_FOUND, { contextId });
    if (this.resident?.contextId === contextId) {
      this.resident.instance.close?.();
      this.resident = null;
    }
    // The row is about to be deleted outright, so there's no point clearing
    // and resaving its `snapshot` field first.
    this.dropStoredSnapshot(contextId, { saveRow: false });
    this.deleteContextRow(contextId);
  }

  // --- per-context snapshots -------------------------------------------------
  //
  // docs/snapshot-cost-design.md folds the snapshot record into the context
  // row's own `snapshot` field, rather than a separate `snapshot:<contextId>`
  // meta key -- it was being written on every execute for no reason the
  // context row can't serve, and folding it in saves a row per execute.

  // Drops a context's stored snapshot (its chunk rows plus the embedded
  // `snapshot` field on its context row) -- used both when a stored
  // snapshot's `build` no longer matches the current engine and when the
  // context itself is deleted. `saveRow: false` skips the load-and-resave of
  // the context row for callers that are about to delete or re-save it
  // themselves right after (`deleteContext`, `ensureInstance`'s stale-build
  // branch): saving it here too would be a wasted row write. With no row
  // read/write left to keep atomic with the DELETE, a bare `.sql.exec()` (a
  // single statement, already atomic) replaces `transactionSync`.
  private dropStoredSnapshot(contextId: string, { saveRow = true }: { saveRow?: boolean } = {}): void {
    if (!saveRow) {
      this.state.storage.sql.exec("DELETE FROM chunks WHERE context_id = ?", contextId);
      return;
    }
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec("DELETE FROM chunks WHERE context_id = ?", contextId);
      const context = this.loadContextRow(contextId);
      if (context && context.snapshot) {
        context.snapshot = null;
        this.saveContext(context);
      }
    });
  }

  // --- resident instance -----------------------------------------------------

  // Returns a live interpreter instance for `context`, reusing the resident
  // one when it already belongs to this context (and isn't invalid).
  // Otherwise the current resident is dropped first -- its state is already
  // persisted after every execute() (see `persist`), so there's nothing to
  // flush -- and this context is booted or restored from its own snapshot
  // rows.
  private ensureInstance(context: ContextRow): SessionInstance {
    if (this.resident && this.resident.contextId === context.id && !this.resident.instance.invalid)
      return this.resident.instance;
    if (this.resident) {
      this.resident.instance.close?.();
      this.resident = null;
    }
    const sessions = this.engine.sessions;
    if (!sessions)
      // Should never happen: InterpreterServer is only ever bound for an
      // Engine that supports code contexts (see Engine.sessions's doc
      // comment) -- a defensive guard, not a real code path.
      throw new ApiError(500, "This engine has no session support", ErrorCode.INTERNAL_ERROR);
    const onCwdChange = (cwd: string) => {
      context.cwd = cwd;
    };
    const snapshot = context.snapshot;
    let instance: SessionInstance;
    let prevPageHashes: Map<number, number>;
    let chunkIds: Set<number>;
    if (snapshot && snapshot.build === this.engine.build) {
      // Restore: read every stored chunk once up front (Durable Object
      // SQLite reads are cheap -- see docs/sessions-design.md's measured
      // 5 ms/16 MiB, 19 ms/64 MiB) into a plain Map so `readPage` below is
      // synchronous, matching the Engine.sessions.restore contract. A page
      // with no row in its chunk's stored bytes (the chunk itself has no
      // row at all, meaning all 16 of its pages were zero when the snapshot
      // was taken) reads back as `undefined`, which restore already treats
      // as "leave zero".
      const rows = [
        ...this.state.storage.sql.exec("SELECT chunk, data FROM chunks WHERE context_id = ?", context.id),
      ] as Array<{ chunk: number; data: Uint8Array | ArrayBuffer }>;
      const byChunk = new Map<number, Uint8Array>(
        rows.map((row) => [row.chunk, row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data)]),
      );
      instance = sessions.restore(
        { workspace: this.workspace, cwd: context.cwd, onCwdChange },
        {
          // Stored as a decimal string (JSON can't carry a BigInt); passing
          // the string straight back as `handle` works unchanged.
          handle: BigInt(snapshot.handle),
          extra: snapshot.extra,
          memoryPages: snapshot.memoryPages,
          readPage: (page) => {
            const chunk = byChunk.get(chunkOf(page));
            if (!chunk) return undefined;
            const offset = (page % CHUNK_PAGES) * PAGE_BYTES;
            return chunk.subarray(offset, offset + PAGE_BYTES);
          },
        },
      );
      // The restored instance's memory isn't necessarily identical to what
      // was stored (restore only replays non-zero pages) -- hash it once so
      // the next diff is exact.
      prevPageHashes = hashMemory(instance.snapshot().memory);
      chunkIds = new Set(byChunk.keys());
    } else {
      if (snapshot) {
        // stale build: boot fresh, replay nothing. `context.snapshot` is
        // cleared in memory here and the row is saved later (by `persist`,
        // once this execute() completes), so the drop itself doesn't need
        // to touch the row.
        this.dropStoredSnapshot(context.id, { saveRow: false });
        context.snapshot = null;
      }
      instance = sessions.boot({ workspace: this.workspace, cwd: context.cwd, onCwdChange });
      prevPageHashes = new Map();
      chunkIds = new Set();
    }
    this.resident = { contextId: context.id, instance, prevPageHashes, chunkIds };
    return instance;
  }

  // Writes the resident context's row (with its embedded snapshot record)
  // plus its memory chunk diff for execute(), and interpreter meta -- all in
  // one transaction (docs/sessions-design.md step 4, extended per context
  // and per docs/snapshot-cost-design.md's chunked write unit). There is no
  // file diff to persist: /workspace is in-memory only (see the module
  // comment). `meta` is only written when the caller passes one: most
  // callers now route their `lastUsed` update through the throttled
  // `touchAlarm` instead of writing it here on every call.
  private persist(
    meta: InterpreterMeta | null,
    contextWrite: {
      context: ContextRow;
      chunkWrites: { upsert: Array<[number, Uint8Array]>; remove: number[] } | null;
      snapshotRecord: SnapshotRecord | null;
    } | null,
  ): void {
    this.state.storage.transactionSync(() => {
      if (contextWrite) {
        const { context, chunkWrites, snapshotRecord } = contextWrite;
        if (chunkWrites) {
          // A chunk that went entirely back to zero is deleted rather than
          // stored (same rule format <= 2 applied per page).
          for (const chunk of chunkWrites.remove)
            this.state.storage.sql.exec("DELETE FROM chunks WHERE context_id = ?1 AND chunk = ?2", context.id, chunk);
          for (const [chunk, data] of chunkWrites.upsert) {
            this.state.storage.sql.exec(
              "INSERT INTO chunks (context_id, chunk, data) VALUES (?1, ?2, ?3) ON CONFLICT(context_id, chunk) DO UPDATE SET data = ?3",
              context.id,
              chunk,
              data,
            );
          }
        }
        if (snapshotRecord) context.snapshot = snapshotRecord;
        this.saveContext(context);
      }
      if (meta) this.saveInterpreterMeta(meta);
    });
  }

  // --- idle expiry ---------------------------------------------------------

  // Called after every request that touches this interpreter (everything
  // but DELETE, which has nothing left to expire). Throttled re-arm policy:
  // `IdleAlarm` (`@sandbox-workers/core`'s idle-alarm.ts) -- the same class
  // the caller-hosted `Sandbox` Durable Object uses.
  private async touchAlarm(meta: InterpreterMeta): Promise<number | null> {
    return this.idleAlarm.touch((nowIso) => {
      meta.lastUsed = nowIso;
      this.saveInterpreterMeta(meta);
    });
  }

  // Shared by DELETE /interpreters/:key and the alarm handler below: wipe
  // all Durable Object storage (meta, contexts, chunks) and drop the
  // in-memory instance/workspace so a later request starts completely
  // fresh.
  private async destroy(): Promise<void> {
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
    this.createTables();
    this.resident?.instance.close?.();
    this.resident = null;
    this.workspace = new Workspace();
    this.idleAlarm.reset();
  }

  // Durable Object alarm handler: fires at whatever deadline was last armed.
  // Because the alarm is throttled (see `touchAlarm` above), that deadline
  // can be stale by up to `TTL / 10` -- so before destroying anything,
  // re-check the real deadline computed from the persisted `lastUsed` and,
  // if activity since the last arm pushed it into the future, re-arm to
  // that time instead of expiring early (docs/snapshot-cost-design.md,
  // "Alarm policy").
  async alarm(): Promise<void> {
    const meta = this.loadInterpreterMeta();
    if (meta == null) return;
    if ((await this.idleAlarm.onAlarm(meta.lastUsed)) === "destroy") await this.destroy();
  }

  // --- HTTP surface and RPC entrypoint --------------------------------------

  // Both fetch() and executeInContext() are serialized through the same
  // promise chain: the Durable Object otherwise interleaves calls at any
  // await point, which would race two executions against the same in-memory
  // workspace/instance.
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    // Keep the queue alive even if this call rejects, and never let one
    // caller observe another's unrelated rejection.
    this.queue = next.catch(() => {});
    return next;
  }

  async fetch(request: Request): Promise<Response> {
    return this.enqueue(() => this.handle(request));
  }

  async executeInContext(
    key: string,
    args: InterpreterExecuteArgs,
    getFiles: GetWorkspaceFiles,
  ): Promise<InterpreterExecuteRpcResult> {
    return this.enqueue(() => this.executeInContextImpl(key, args, getFiles));
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const key = request.headers.get(INTERPRETER_KEY_HEADER) ?? "";
      if (!INTERPRETER_KEY_PATTERN.test(key)) throw new ApiError(400, "Invalid interpreter key");
      const path = new URL(request.url).pathname;
      const method = request.method;

      if (method === "DELETE" && path === "/") {
        await this.destroy();
        return json({ success: true });
      }

      const meta = this.ensureInterpreterMeta(key);

      if (method === "POST" && path === "/contexts") return await this.createContext(request, meta);
      const contextMatch = /^\/contexts\/([^/]+)$/.exec(path);
      if (method === "DELETE" && contextMatch) {
        this.deleteContext(decodeURIComponent(contextMatch[1]));
        await this.touchAlarm(meta);
        return json({ success: true });
      }

      throw new ApiError(404, "Not found", ErrorCode.VALIDATION_FAILED);
    } catch (error) {
      if (error instanceof WorkspaceError) return errnoErrorResponse(error.code, error.message, {});
      return errorResponse(error);
    }
  }

  private async createContext(request: Request, meta: InterpreterMeta): Promise<Response> {
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
    const context = this.createContextRecord({ id: body.id, cwd });
    await this.touchAlarm(meta);
    return json({ id: context.id, cwd: context.cwd, createdAt: context.createdAt }, { status: 201 });
  }

  // RPC method the runtime Worker's `executeInContext` forwards to (see
  // docs/sandbox-1-0-design.md, "Workspace mirror and sync protocol").
  // `args` is `InterpreterExecuteArgs` (contextId, code, envVars, a
  // manifest-only `workspace`, no file contents); `getFiles` is the
  // sandbox's own RPC stub, called back at most once, for exactly the paths
  // this interpreter's mirror is missing after reconciling against the
  // manifest. Errors are returned as `{ ok: false, status, body }` rather
  // than thrown -- Workers RPC only serializes an Error's
  // `name`/`message`/`stack`, which would drop `code`/`details`/HTTP status
  // the sandbox relies on (see `errorBody` in `@sandbox-workers/core`).
  private async executeInContextImpl(
    key: string,
    args: InterpreterExecuteArgs,
    getFiles: GetWorkspaceFiles,
  ): Promise<InterpreterExecuteRpcResult> {
    try {
      if (!INTERPRETER_KEY_PATTERN.test(key)) throw new ApiError(400, "Invalid interpreter key");
      const meta = this.ensureInterpreterMeta(key);

      if (typeof args?.code !== "string" || !args.code.trim()) throw new ApiError(400, "Non-empty code is required");
      if (new TextEncoder().encode(args.code).length > MAX_CODE_BYTES) throw new ApiError(413, "Code exceeds 64 KiB");
      const envVars = validateEnvVarsObject(args?.envVars) ?? {};
      if (typeof args?.contextId !== "string" || !args.contextId)
        throw new ApiError(400, "contextId must be a non-empty string");
      const workspaceManifest = validateWorkspaceManifest(args?.workspace);

      const context = this.loadContextRow(args.contextId);
      if (!context)
        throw new ApiError(404, `Code context '${args.contextId}' not found`, ErrorCode.CONTEXT_NOT_FOUND, {
          contextId: args.contextId,
        });

      // Must be set before run() -> ensureInstance() boots/restores the
      // instance and wires the engine's WASI host workspaceDisabled getter
      // to this flag. applySync below ignores this flag entirely (an empty
      // manifest still wipes the mirror down to nothing even while
      // disabled), and destroy() builds a fresh Workspace (disabled
      // defaults to false), so the flag always resets on eviction.
      this.workspace.disabled = workspaceManifest.disabled;

      // Reconcile the mirror before running anything (docs/sandbox-1-0-
      // design.md, "Workspace mirror and sync protocol"): create dirs,
      // delete whatever the manifest no longer names, and note any file
      // whose hash still doesn't match (this interpreter was evicted, or
      // never held this workspace at all). Pull exactly those paths from
      // the sandbox over `getFiles`, apply them, and re-check -- the
      // sandbox is the source of truth, so a still-missing path after that
      // means the sandbox itself failed to provide it.
      let { missing } = this.workspace.applySync({
        dirs: workspaceManifest.dirs,
        files: [],
        manifest: workspaceManifest.manifest,
      });
      if (missing.length > 0) {
        const pulled = await getFiles(missing);
        validatePulledFiles(pulled, missing);
        ({ missing } = this.workspace.applySync({
          dirs: workspaceManifest.dirs,
          files: pulled,
          manifest: workspaceManifest.manifest,
        }));
        if (missing.length > 0)
          throw new ApiError(500, `Sandbox did not provide ${missing.length} workspace file(s)`, ErrorCode.INTERNAL_ERROR);
      }

      const result = this.run(context, args.code, envVars);
      await this.touchAlarm(meta);
      return { ok: true, result };
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const { status, body } = errnoErrorBody(error.code, error.message, {});
        return { ok: false, status, body };
      }
      const { status, body } = errorBody(error);
      return { ok: false, status, body };
    }
  }

  // The post-reconciliation body of what used to be `_execute`'s HTTP
  // handler: run the guest code, snapshot memory, and build the response
  // object (still consumed by `executeInContextImpl` above, wrapped as
  // `{ ok: true, result }`). Synchronous -- nothing here awaits.
  //
  // Session-contract normalization (tmp/interpreter-core-split-design.md
  // section 4 + phase 3): `SessionInstance.execute` never throws for a guest
  // error or a resource limit -- both come back as `outcome.error`. The
  // rules below replace the old threw/trap/invalid case analysis:
  //   1. If `instance.execute()` itself throws, that is a host bug: treat it
  //      like a trap (drop the resident, no snapshot) and fold it into the
  //      standard error envelope via `engineErrorOutcome`.
  //   2. After the call, if `instance.invalid`, drop the resident (covers a
  //      throw-free invalidation, e.g. Python/Perl's fuel trap; a no-op if
  //      rule 1 already dropped it).
  //   3. Snapshot only when still resident, `canSnapshot()`, and this
  //      round's outcome isn't `ExecutionLimitError` -- a limit hit never
  //      snapshots that round, matching the pre-split behavior for JS's
  //      clean interrupt (which used to throw and so skip the snapshot
  //      branch entirely).
  //   4. A guest error (`outcome.error` present) still rolls the workspace
  //      mirror back with `restoreFrom(before)`, same as before.
  //   5. `outcome.cwd` feeds `context.cwd`.
  private run(context: ContextRow, code: string, envVars: Record<string, string>): InterpreterExecuteResponse {
    // The response `workspace` diff is taken from right after
    // reconciliation, not from whatever this context's mirror looked like
    // before -- reconciliation itself is not "this execution's changes".
    const changesSince = this.workspace.changes().snapshot;

    const instance = this.ensureInstance(context);
    const before = this.workspace.serialize();

    let outcome: SessionOutcome;
    try {
      outcome = instance.execute({ code, envVars });
    } catch (error) {
      // Rule 1.
      if (this.resident?.contextId === context.id) this.resident = null;
      outcome = { ...engineErrorOutcome(error), cwd: context.cwd };
    }

    context.executions++;
    context.lastUsed = new Date().toISOString();
    // meta.lastUsed is no longer set here: it goes through the throttled
    // touchAlarm below (docs/snapshot-cost-design.md decision 3), which
    // writes it only when the alarm actually re-arms. The context row above
    // still gets an exact lastUsed on every execute.
    if (outcome.cwd) context.cwd = outcome.cwd; // Rule 5.

    // Rule 4: a guest-level error (result.error without a throw) discards
    // this execution's workspace writes in place (keeps `workspace.root`'s
    // identity, so a still-alive instance's WASI mount / host functions keep
    // seeing the same object) -- but an ordinary guest exception does NOT
    // invalidate the instance or block a memory snapshot, only invalid does
    // (handled below).
    let fileDiff: { created: string[]; updated: string[]; deleted: string[] } | null = null;
    if (outcome.error) {
      this.workspace.restoreFrom(before);
    } else {
      fileDiff = this.workspace.changes(changesSince);
    }

    // Rule 2.
    if (instance.invalid && this.resident?.contextId === context.id) this.resident = null;

    // Rule 3.
    let snapshotMs: number | undefined;
    const resident = this.resident?.contextId === context.id ? this.resident : null;
    const limited = outcome.error?.name === "ExecutionLimitError";
    const live = limited ? null : resident?.instance;
    if (live && resident && live.canSnapshot()) {
      const start = performance.now();
      const snap = live.snapshot();
      const memoryPages = Math.round(snap.memory.buffer.byteLength / PAGE_BYTES);
      const pageDiff = diffPages(snap.memory, resident.prevPageHashes);
      resident.prevPageHashes = pageDiff.hashes;
      // Page diff -> chunk writes (docs/snapshot-cost-design.md decision 1):
      // only the chunks containing a changed or removed page are touched,
      // and `resident.chunkIds` (the running set of chunks actually stored
      // for this context) is updated incrementally so `chunkCount` below
      // never needs its own read.
      const { upsert, remove } = chunksToWrite(pageDiff, pageDiff.hashes);
      for (const chunk of remove) resident.chunkIds.delete(chunk);
      for (const chunk of upsert) resident.chunkIds.add(chunk);
      const chunkWrites = {
        upsert: upsert.map((chunk): [number, Uint8Array] => [chunk, readChunk(snap.memory, chunk, memoryPages)]),
        remove,
      };
      const snapshotRecord: SnapshotRecord = {
        build: this.engine.build,
        memoryPages,
        pageCount: pageDiff.hashes.size,
        bytes: pageDiff.hashes.size * PAGE_BYTES,
        // Storage footprint, not live-data size (see snapshotInfo): a chunk
        // with any non-zero page is stored whole.
        chunkCount: resident.chunkIds.size,
        handle: String(snap.handle),
        extra: snap.extra,
        takenAt: Date.now(),
        stale: false,
      };
      this.persist(null, { context, chunkWrites, snapshotRecord });
      snapshotMs = performance.now() - start;
    } else {
      // canSnapshot() is false (the guest still holds an open file
      // descriptor beyond the preopens) or this round's outcome was an
      // ExecutionLimitError: the execution result still stands, but
      // restoring the on-disk snapshot later would replay an older memory
      // image than what this execution produced. Flag it so the response's
      // `context.snapshot.stale` is true. When there's no live resident at
      // all (dropped above), leave the existing snapshot record untouched
      // -- it still describes a genuinely valid prior state.
      const existing = live ? context.snapshot : null;
      const staleRecord = existing && !existing.stale ? { ...existing, stale: true } : null;
      this.persist(null, { context, chunkWrites: null, snapshotRecord: staleRecord });
    }

    const { cwd: _cwd, ...outcomeFields } = outcome;
    return {
      code,
      language: this.engine.language,
      engine: this.engine.engineName,
      durationMs: 0,
      ...outcomeFields,
      executionCount: context.executions,
      context: {
        id: context.id,
        cwd: context.cwd,
        executions: context.executions,
        ...(snapshotMs !== undefined ? { snapshotMs } : {}),
        snapshot: context.snapshot ? snapshotInfo(context.snapshot) : null,
      },
      workspace: buildWorkspaceResponse(this.workspace, fileDiff),
    };
  }
}
