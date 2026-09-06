// Linear-memory snapshot helpers shared by createJavaScriptSession/
// restoreJavaScriptSession (runtime/javascript.mjs) and createEmbeddedSession/
// restoreEmbeddedSession (runtime/embedded.mjs), and consumed by the Durable
// Object (runtime/sandbox.mjs) to decide what to write to the `chunks` table
// (docs/snapshot-cost-design.md: 1 MiB chunks of 16 pages each, not one row
// per changed 64 KiB page).
//
// Deviation from docs/sessions-design.md, agreed up front: pages are stored
// RAW, not deflated. A prototype measured per-page deflate at ~450 ms for a
// 39 MiB image -- too slow for the request path. All-zero pages are skipped
// (a fresh WebAssembly.Memory is zero-filled, so "no row" already means
// "zero page" both for a brand-new session and for a page that went back to
// all-zero) and only pages whose hash changed since the last snapshot are
// rewritten.
//
// Page hashing is FNV-1a over 32-bit words (Math.imul), not raw bytes: four
// times fewer loop iterations than a byte-wise hash for the same coverage.
// Measured at ~17 ms for a 39 MiB image; not cryptographic, only used for
// cheap change detection between snapshots.

export const PAGE_BYTES = 65536; // 64 KiB: the Wasm page size.
const WORDS_PER_PAGE = PAGE_BYTES / 4;

function hashWords(u32, start) {
  let h = 0x811c9dc5;
  for (let i = 0; i < WORDS_PER_PAGE; i++) {
    h = (h ^ u32[start + i]) >>> 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isZero(u32, start) {
  for (let i = 0; i < WORDS_PER_PAGE; i++) if (u32[start + i] !== 0) return false;
  return true;
}

export function memoryPageCount(memory) {
  return memory.buffer.byteLength / PAGE_BYTES;
}

// Hashes every non-zero 64 KiB page of `memory` (a WebAssembly.Memory, whose
// buffer may be a SharedArrayBuffer -- a plain Uint32Array view over it works
// fine for reading). Returns a Map<pageIndex, hash:uint32>; all-zero pages
// are omitted so a freshly grown (zero-filled) region costs nothing to scan
// past for the caller's diff.
export function hashMemory(memory) {
  const u32 = new Uint32Array(memory.buffer);
  const pages = memoryPageCount(memory);
  const hashes = new Map();
  for (let page = 0; page < pages; page++) {
    const start = page * WORDS_PER_PAGE;
    if (isZero(u32, start)) continue;
    hashes.set(page, hashWords(u32, start));
  }
  return hashes;
}

// Copies one page out of `memory` as a plain (non-shared-buffer-backed)
// Uint8Array: Durable Object SQLite BLOB binding rejects a SharedArrayBuffer
// view directly, but `.slice()` on the Uint8Array view produces a copy on a
// fresh ArrayBuffer, which binds fine.
export function readPage(memory, page) {
  return new Uint8Array(memory.buffer, page * PAGE_BYTES, PAGE_BYTES).slice();
}

// Writes a previously-read page's bytes back into `memory` at `page`,
// starting from an already zero-filled instance (see restore in
// runtime/javascript.mjs / runtime/embedded.mjs) -- used to replay a
// snapshot's non-zero pages into a freshly instantiated engine.
export function writePage(memory, page, data) {
  new Uint8Array(memory.buffer, page * PAGE_BYTES, PAGE_BYTES).set(data);
}

// Diffs `memory`'s current non-zero pages against `prevHashes` (a
// Map<pageIndex, hash> from a previous call, or omitted for the first one).
// `changed` holds only the pages whose hash actually differs (or is new),
// each copied out with readPage(); `removed` lists pages that were non-zero
// before and are all-zero now (the Durable Object deletes those rows rather
// than storing a zero-filled page). Returns the fresh hash map too, to keep
// as `prevHashes` for the next call.
export function diffPages(memory, prevHashes = new Map()) {
  const hashes = hashMemory(memory);
  const changed = [];
  for (const [page, hash] of hashes) {
    if (prevHashes.get(page) !== hash) changed.push([page, readPage(memory, page)]);
  }
  const removed = [];
  for (const page of prevHashes.keys()) if (!hashes.has(page)) removed.push(page);
  return { hashes, changed, removed };
}

// docs/snapshot-cost-design.md decision 1: the Durable Object no longer
// writes one row per changed 64 KiB page (a rowid table with a composite
// TEXT primary key counts 2 rows written per INSERT -- table plus implicit
// index; see the design doc's "Problem" section). Instead it writes whole
// 1 MiB chunks (16 pages) to a WITHOUT ROWID table, which counts 1 row per
// INSERT regardless of how many of its pages actually changed. Page-level
// change detection (hashMemory/diffPages above) is unchanged; only the
// write unit is coarser.
export const CHUNK_PAGES = 16;
export const CHUNK_BYTES = CHUNK_PAGES * PAGE_BYTES; // 1 MiB

// The chunk that contains `page` (chunk 0 covers pages 0-15, chunk 1 covers
// 16-31, and so on).
export function chunkOf(page) {
  return Math.floor(page / CHUNK_PAGES);
}

// Copies chunk `chunk` (CHUNK_PAGES consecutive Wasm pages) out of `memory`
// as a plain (non-shared-buffer-backed) CHUNK_BYTES-length Uint8Array, for
// the `chunks` table. `memoryPages` is the memory's total page count
// (stored alongside the snapshot record; memory only ever grows by whole
// pages, so this is exact). A chunk that reaches past the end of memory
// cannot occur except for the last chunk when `memoryPages % CHUNK_PAGES !=
// 0` -- in that case the pages that exist are copied and the rest of the
// 1 MiB buffer is left zero-filled, matching what a freshly grown
// WebAssembly.Memory already looks like.
export function readChunk(memory, chunk, memoryPages) {
  const startPage = chunk * CHUNK_PAGES;
  const validPages = Math.max(0, Math.min(CHUNK_PAGES, memoryPages - startPage));
  if (validPages === CHUNK_PAGES) {
    return new Uint8Array(memory.buffer, startPage * PAGE_BYTES, CHUNK_BYTES).slice();
  }
  const chunkData = new Uint8Array(CHUNK_BYTES); // zero-filled trailing partial chunk
  if (validPages > 0) {
    chunkData.set(new Uint8Array(memory.buffer, startPage * PAGE_BYTES, validPages * PAGE_BYTES));
  }
  return chunkData;
}

// Turns a diffPages() result into the chunk-level writes runtime/sandbox.mjs
// needs: every chunk touched by a changed or removed page is either
// rewritten (`upsert`, when at least one of its 16 pages is still non-zero
// per `hashes`) or dropped entirely (`remove`, when none is -- the whole
// chunk went back to zero, same rule as an all-zero page having no row
// today). `hashes` is the fresh Map<page, hash> from the same diffPages()
// call (`diff.hashes` works; it's accepted separately so callers that
// already destructured `{ hashes, changed, removed }` can pass `hashes`
// straight through). Returns `{ upsert: number[], remove: number[] }`,
// chunk indices sorted ascending.
export function chunksToWrite(diff, hashes) {
  const touched = new Set();
  for (const [page] of diff.changed) touched.add(chunkOf(page));
  for (const page of diff.removed) touched.add(chunkOf(page));
  const upsert = [];
  const remove = [];
  for (const chunk of touched) {
    const start = chunk * CHUNK_PAGES;
    let nonZero = false;
    for (let page = start; page < start + CHUNK_PAGES; page++) {
      if (hashes.has(page)) {
        nonZero = true;
        break;
      }
    }
    (nonZero ? upsert : remove).push(chunk);
  }
  upsert.sort((a, b) => a - b);
  remove.sort((a, b) => a - b);
  return { upsert, remove };
}
