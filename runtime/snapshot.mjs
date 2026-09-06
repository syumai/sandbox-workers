// Linear-memory snapshot helpers shared by createJavaScriptSession/
// restoreJavaScriptSession (runtime/javascript.mjs) and createEmbeddedSession/
// restoreEmbeddedSession (runtime/embedded.mjs), and consumed by the Durable
// Object (runtime/sandbox.mjs) to decide what to write to the `pages` table.
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
