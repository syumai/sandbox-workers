# Snapshot storage cost reduction: design

Status: design accepted and phase 1 implemented 2026-09-06 (branch `snapshot-cost-reduction`), measurements verified the same day
(workerd 4.129.0 via `wrangler dev`, Node 24 for the engine measurements).
Amends the storage layout in `docs/sessions-design.md` (still the reference
for the snapshot mechanism itself) and the `Sandbox` Durable Object described
in `docs/sdk-parity-design.md`. Nothing in the HTTP API or the typed client
changes shape; only storage rows, the alarm policy, and two informational
fields do.

## Problem

Workers Paid pricing (Durable Objects, SQLite backend, 2026): rows written
$1.00 per million, rows read $0.001 per million, requests $0.15 per million,
duration $12.50 per million GB-s at a fixed 128 MB. Row size does not matter.
Every `execute` in a code context therefore pays mostly for *how many rows*
the snapshot diff touches, and the current layout (`pages`, one 64 KiB page
per row, composite `TEXT` primary key) is close to the worst case:

| Per execute (resident instance) | JavaScript | Python | Perl |
| --- | --- | --- | --- |
| Changed 64 KiB pages, small REPL step | 17–22 | 46–57 | 24–32 |
| Changed 64 KiB pages, allocation-heavy step | 36 | 94–176 | 105–158 |
| Fixed rows (snapshot meta, context, sandbox meta, `setAlarm`) | 4 | 4 | 4 |
| First snapshot of a context (every non-zero page inserted, 2 rows each) | ~680 | ~270 | ~135 |

Measured against workerd: an `INSERT` into a rowid table with a composite
`TEXT` primary key counts **2** rows written (table + implicit index); an
`UPDATE` via `ON CONFLICT DO UPDATE` counts **1**, even when the value is
unchanged; a `DELETE` counts **1** per matched row; `WITHOUT ROWID` and
`INTEGER PRIMARY KEY` tables count **1** per `INSERT`. Reads count rows, not
bytes. Writing 21 MiB as 336 × 64 KiB rows or as 21 × 1 MiB rows takes the
same wall-clock time (40–85 ms), so write time is a function of bytes, and
cost is a function of rows.

## Decisions

1. **Store memory in 1 MiB chunks (16 pages) in a `WITHOUT ROWID` table.**
   Change detection stays at 64 KiB page granularity (`hashMemory`); the
   write unit becomes the chunk containing a changed page. Measured effect
   on rows per execute: JavaScript 17–36 pages → **7** chunks (every small
   step touches the same 7 heap regions), Python 46–176 → **8–17**, Perl
   24–158 → **3–15**. First snapshot: JavaScript 28 chunks, Python 10, Perl 5
   (versus 680/270/135 rows). The price is bytes: a one-variable JavaScript
   step now writes ~7 MiB instead of ~1.1 MiB, about +15–25 ms of Durable
   Object wall time per execute (duration cost ~$0.00000003, below noise).
   256 KiB chunks were measured too (JavaScript 11 rows, Python 20–55, Perl
   9–45) and rejected: fewer bytes but noticeably more rows.
2. **Fold the per-context snapshot record into the `contexts` row.** The
   `snapshot:<contextId>` meta row is written on every execute for no reason
   the context row cannot serve. Saves 1 row per execute, 2 on first snapshot.
3. **Throttle `lastUsed` and the expiry alarm.** Re-arm the alarm and rewrite
   `meta.sandbox.lastUsed` only when the new deadline is more than
   `TTL / 10` later than the armed one. The alarm handler no longer destroys
   unconditionally: it reloads `lastUsed`, and if `lastUsed + TTL` is still
   in the future it re-arms to that time instead. Saves up to 2 rows per
   execute at steady state; a sandbox may now be deleted after as little as
   0.9 × TTL of inactivity (documented), never earlier.
4. **Rejected: diffing against a canonical boot image** (the follow-up
   named in `docs/sessions-design.md`). Two fresh boots of the same engine
   build differ in 8/336 pages (JavaScript), 83/131 (Python), 32/64 (Perl)
   after the same trivial execution: hash seeds and other per-boot entropy
   land in linear memory. A restore that booted fresh and overlaid stored
   pages would mix two boots' state. Not pursued.
5. **Deferred, opt-in: debounced flushing** (phase 2, off by default). See
   "Phase 2" below.

Expected rows per execute after decisions 1–3, steady state:

| | JavaScript | Python | Perl |
| --- | --- | --- | --- |
| Today | 21–40 | 50–180 | 28–162 |
| After | 8–9 | 9–19 | 4–17 |
| First snapshot, today → after | ~680 → ~31 | ~270 → ~13 | ~135 → ~8 |

At $1.00 per million rows that is roughly $0.000009 per JavaScript execute
instead of $0.00002–0.00004, and the free tier (50 million rows/month) then
covers about 5–6 million executes instead of ~1.5 million.

## Storage layout (format 3)

```sql
CREATE TABLE IF NOT EXISTS files    (path TEXT PRIMARY KEY, data BLOB, updated_at INTEGER);   -- unchanged
CREATE TABLE IF NOT EXISTS meta     (key TEXT PRIMARY KEY, value TEXT);                        -- only key 'sandbox' remains
CREATE TABLE IF NOT EXISTS contexts (id TEXT PRIMARY KEY, value TEXT);                         -- value gains `snapshot`
CREATE TABLE IF NOT EXISTS chunks   (context_id TEXT, chunk INTEGER, data BLOB,
                                     PRIMARY KEY (context_id, chunk)) WITHOUT ROWID;
```

- `chunks.data` is exactly `CHUNK_BYTES = 16 * PAGE_BYTES = 1 MiB`, raw. A
  chunk whose 16 pages are all zero has no row (same rule as today's zero
  pages). The Durable Object row limit is 2 MB; 1 MiB leaves headroom.
- `contexts.value` JSON: `{ id, language, cwd, envVars, createdAt, lastUsed,
  executions, snapshot }` where `snapshot` is `null` or
  `{ build, handle, extra, memoryPages, pageCount, bytes, chunkCount,
  takenAt, stale }` (today's record plus `chunkCount`).
- `meta.sandbox` JSON gains `format: 3`. `_ensureSchema` treats a missing
  `chunks` table, a present `pages` table, a legacy `session` key, or
  `format < 3` as old storage and wipes it (`deleteAll` + recreate), exactly
  as format 2 wiped format 1. Existing sandboxes are discarded on first
  access after deploy (the public Playground's TTL is 1 h, so this is a
  non-event there; document it in the upgrade guide anyway).

## Execute flow changes (`@sandbox-workers/interpreter`'s server.ts)

Step 4 of the execute sequence in `docs/sessions-design.md` becomes:

1. `diffPages(memory, prevPageHashes)` as today → `{ hashes, changed, removed }`.
2. `changedChunks = new Set([...changed pages, ...removed pages].map(p => p >> 4))`.
3. For each chunk in `changedChunks`: if none of its 16 pages is in
   `hashes` (all zero now) → `DELETE FROM chunks WHERE context_id = ? AND chunk = ?`;
   otherwise copy `memory.buffer[chunk * CHUNK_BYTES, +CHUNK_BYTES)` with
   `.slice()` (a plain `ArrayBuffer`; the SQLite binding rejects
   `SharedArrayBuffer` views) and upsert
   `INSERT INTO chunks (context_id, chunk, data) VALUES (?1, ?2, ?3)
   ON CONFLICT(context_id, chunk) DO UPDATE SET data = ?3`.
   A chunk that reaches past the current memory size cannot occur (memory is
   a whole number of pages and `memoryPages` is stored); a trailing partial
   chunk only happens when `memoryPages % 16 != 0`, in which case copy the
   pages that exist and zero-fill the rest of the 1 MiB buffer.
4. Write the context row (with the embedded snapshot record) — 1 row.
5. Apply decision 3 for `meta.sandbox` and the alarm (0–2 rows).
6. All of the above inside one `transactionSync`, as today.

`diffPages` stays page-based. Add to `@sandbox-workers/interpreter/snapshot`:
`CHUNK_PAGES = 16`, `CHUNK_BYTES`, `chunkOf(page)`, `readChunk(memory,
chunk, memoryPages)` (with the zero-fill rule), and `chunksToWrite(diff,
hashes)` returning `{ upsert: number[], remove: number[] }`. These are pure
functions and get pure-Node tests.

Restore (`_ensureInstance`): `SELECT chunk, data FROM chunks WHERE context_id = ?`
into a `Map<chunk, Uint8Array>`, then
`readPage: (page) => byChunk.get(page >> 4)?.subarray((page & 15) * PAGE_BYTES, ((page & 15) + 1) * PAGE_BYTES)`.
`restoreJavaScriptSession` / `restoreEmbeddedSession` need no change: they
call `readPage` for every page below `memoryPages` and `writePage` whatever
is truthy, so an all-zero page sliced out of a stored chunk is harmless.
Verified end to end for all three languages (chunk store → restore → the
variable defined before the snapshot reads back).

`_dropStoredSnapshot(contextId)` becomes `DELETE FROM chunks WHERE
context_id = ?` plus clearing `snapshot` in the context row.
`_deleteContext` and `_destroy` follow. The stale-snapshot path (guest holds
open fds, `canSnapshot()` false) is unchanged except that the `stale` flag
now lives in the context row.

## Alarm policy (decision 3)

```
_touchAlarm(now):
  ttl = _idleTtlMs(); if ttl == 0: deleteAlarm() if armed; return null
  armed = this.alarmAt ?? await storage.getAlarm()        // getAlarm is a read, ~free
  want  = now + ttl
  if armed == null or want - armed > ttl / 10:
      setAlarm(want); this.alarmAt = want; write meta.sandbox.lastUsed = now
      return want                                        // the deadline just armed
  return armed                                           // unchanged: still the armed deadline

alarm():
  meta = _loadSandboxMeta(); ttl = _idleTtlMs()
  if meta == null or ttl == 0: return
  deadline = Date.parse(meta.lastUsed) + ttl
  if deadline > Date.now(): setAlarm(deadline); this.alarmAt = deadline; return
  await _destroy()
```

`this.alarmAt` is an in-memory cache and may be lost on eviction; the
`getAlarm()` fallback keeps the logic correct after a cold start.
`lastUsed` on the wire (`GET /sandboxes/:id`, `context.lastUsed`) is served
from memory when the sandbox is resident and from storage otherwise, so it
can lag by up to `TTL / 10` after an eviction. `expiresAt` reports the armed
deadline, so it is always exact. Requests that already write `meta.sandbox`
for another reason (`setEnvVars`) keep writing `lastUsed` for free.

Behavioural change to document in `website/content/guides/code-contexts.md`: a
sandbox is deleted after somewhere between 0.9 × TTL and TTL of inactivity
(today: exactly TTL, modulo alarm scheduling). `SESSION_IDLE_TTL_MS = "0"`
still disables expiry entirely.

## Observable changes

- `SandboxInfo.contexts[].snapshot.pages` / `.bytes` keep meaning non-zero
  64 KiB pages and their size (live data). Add `storedBytes`
  (`chunkCount * CHUNK_BYTES`) so operators can see the storage footprint.
- `context.snapshotMs` now includes chunk copying; expect +5–25 ms.
- Latency: +15–25 ms per JavaScript execute from the extra bytes written.
- Storage per JavaScript context grows from ~22 MiB to ~28 MiB (chunks that
  are mostly zero are stored whole). At $0.20 per GB-month with a 1 h TTL
  this is noise; at `SESSION_IDLE_TTL_MS = "0"` it is $0.0055 per context per
  month.

## Risks and how they were checked

| Risk | Check | Result |
| --- | --- | --- |
| `WITHOUT ROWID` unsupported in Durable Object SQLite | created and used the table in workerd | supported; insert counts 1 row |
| Row counting differs from the assumption | `SqlStorageCursor.rowsWritten/rowsRead` per statement in workerd | see "Problem"; matches the D1 pricing definitions |
| 1 MiB values rejected | inserted 1, 1.9, and 2.5 MiB blobs locally | all accepted locally; local workerd does not enforce the production 2 MB limit, so the design keeps 1 MiB with the documented limit as the bound |
| Chunk writes too slow | 21 × 1 MiB vs 336 × 64 KiB in one transaction | same time for the same bytes (40–85 ms per 21 MiB) |
| Restore from chunks corrupts state | chunk store → unmodified restore → read a variable back, all three languages | passes |
| Boot-image diff (rejected alternative) | hash two fresh boots | non-deterministic in all three languages |
| Alarm throttling deletes a live sandbox early | handler re-checks `lastUsed + TTL` before destroying | worst case is expiry at 0.9 × TTL idle |
| Format wipe loses users' sandboxes | same precedent as format 2 | acceptable; note in the upgrade guide |

Not verifiable locally: `setAlarm()` and `deleteAll()` return no counters.
The pricing page states `setAlarm` is one row written and deletions count
as rows written; the estimates above use those.

## Tests

- `tests/snapshot-chunks.test.mjs` (new, pure Node): `chunkOf`,
  `chunksToWrite` (changed page → its chunk; removed page inside a still
  non-zero chunk → upsert, not delete; all-zero chunk → delete; trailing
  partial chunk zero-filled), `readChunk` slicing, and a chunk-store
  round-trip through `restoreJavaScriptSession` / `restoreEmbeddedSession`
  for the three languages (port of the measurement script's section D).
- `tests/sandboxes.mjs`: assert `snapshot.storedBytes` is a multiple of
  1 MiB and `>= snapshot.bytes`; assert `expiresAt` does not move when two
  executes run within `TTL / 10` of each other and does move after a
  `SESSION_IDLE_TTL_MS` small enough to exceed it (run that case against a
  dev server started with `SESSION_IDLE_TTL_MS=20000`).
- `tests/sandboxes-restart.mjs`: unchanged in spirit; it is the end-to-end
  proof that chunked snapshots survive a workerd restart.
- `tests/sessions.test.mjs`, `tests/workspace.test.mjs`: unchanged.
- Manual: `GET /sandboxes/:id` on a format-2 sandbox after deploy returns a
  fresh sandbox (wipe path), no 500.

## Phases

1. Decisions 1–3, format 3, tests, docs (`docs/sessions-design.md` storage
   table, `website/content/guides/code-contexts.md`, `website/content/concepts/code-contexts.md`,
   `website/content/platform/limits.md`). One PR.
2. Opt-in debounced flushing, env var `SNAPSHOT_FLUSH_DELAY_MS` (default
   `"0"` = flush on every execute, today's durability). When non-zero:
   execute updates in-memory state only and arms a flush alarm at
   `now + delay` unless one is already armed (in-memory flag); the alarm
   handler flushes the resident context (chunks + context row + `lastUsed`),
   then re-arms the expiry deadline. Switching contexts, `DELETE`,
   `GET /sandboxes/:id` (to report accurate counts), and file operations
   flush first. Trade-off to document: state produced in the last `delay`
   milliseconds before an unexpected eviction (deploy, crash, memory limit)
   is lost; ordinary idle eviction cannot race a delay under 60 s because
   Durable Objects stay in memory for 70–140 s after their last event. A
   50-execute REPL burst then writes roughly 10 rows instead of ~450.
   Design this as its own document once phase 1 has shipped; it needs the
   single-alarm multiplexing above and changes the durability contract
   `docs/sessions-design.md` promises.
