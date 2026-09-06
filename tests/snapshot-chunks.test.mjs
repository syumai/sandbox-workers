// Pure-Node tests for docs/snapshot-cost-design.md decision 1 (1 MiB chunks
// instead of one row per changed 64 KiB page): the pure helpers added to
// runtime/snapshot.mjs (chunkOf, readChunk, chunksToWrite), plus a
// chunk-store round trip through the unmodified restore functions for all
// three snapshot languages (a port of the design doc's measurement script,
// section D) proving a chunk-keyed `readPage` closure like
// runtime/sandbox.mjs's `_ensureInstance` builds is a drop-in replacement
// for the old page-keyed one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createJavaScriptSession,
  restoreJavaScriptSession,
} from "../runtime/javascript.mjs";
import {
  createEmbeddedSession,
  restoreEmbeddedSession,
} from "../runtime/embedded.mjs";
import { Workspace } from "../runtime/workspace.mjs";
import {
  PAGE_BYTES,
  CHUNK_PAGES,
  CHUNK_BYTES,
  chunkOf,
  readChunk,
  chunksToWrite,
  diffPages,
  memoryPageCount,
} from "../runtime/snapshot.mjs";

// ---- chunkOf ---------------------------------------------------------------

test("chunkOf: 16 pages per chunk", () => {
  assert.equal(chunkOf(0), 0);
  assert.equal(chunkOf(15), 0);
  assert.equal(chunkOf(16), 1);
  assert.equal(chunkOf(31), 1);
  assert.equal(chunkOf(32), 2);
  assert.equal(CHUNK_PAGES, 16);
  assert.equal(CHUNK_BYTES, 16 * PAGE_BYTES);
});

// ---- readChunk --------------------------------------------------------------

test("readChunk: a full chunk is copied as a plain CHUNK_BYTES Uint8Array", () => {
  const memory = new WebAssembly.Memory({ initial: 32 }); // 32 pages = 2 chunks
  const view = new Uint8Array(memory.buffer);
  view[0] = 0xaa; // first byte of chunk 0
  view[CHUNK_BYTES - 1] = 0xbb; // last byte of chunk 0
  view[CHUNK_BYTES] = 0xcc; // first byte of chunk 1

  const chunk0 = readChunk(memory, 0, memoryPageCount(memory));
  assert.equal(chunk0.length, CHUNK_BYTES);
  assert.equal(chunk0[0], 0xaa);
  assert.equal(chunk0[CHUNK_BYTES - 1], 0xbb);
  // A plain, non-shared-buffer-backed copy: mutating the source doesn't
  // affect the returned chunk.
  assert.notEqual(chunk0.buffer, memory.buffer);
  view[0] = 0;
  assert.equal(chunk0[0], 0xaa);

  const chunk1 = readChunk(memory, 1, memoryPageCount(memory));
  assert.equal(chunk1[0], 0xcc);
});

test("readChunk: a trailing partial chunk is zero-filled past the end of memory", () => {
  // 20 pages: chunk 0 is full (pages 0-15), chunk 1 only has pages 16-19 (4
  // of its 16 pages) -- the rest of its 1 MiB buffer must read back as zero.
  const memory = new WebAssembly.Memory({ initial: 20 });
  const view = new Uint8Array(memory.buffer);
  const partialStart = CHUNK_PAGES * PAGE_BYTES;
  view[partialStart] = 0x42; // first byte of the 4 real pages in chunk 1
  view[partialStart + 4 * PAGE_BYTES - 1] = 0x43; // last byte of the 4th real page

  const chunk1 = readChunk(memory, 1, memoryPageCount(memory));
  assert.equal(chunk1.length, CHUNK_BYTES);
  assert.equal(chunk1[0], 0x42);
  assert.equal(chunk1[4 * PAGE_BYTES - 1], 0x43);
  // Past the 4 real pages (memoryPages=20 means chunk 1 only has pages
  // 16-19), the rest of the 1 MiB buffer is zero-filled.
  for (let i = 4 * PAGE_BYTES; i < CHUNK_BYTES; i++) assert.equal(chunk1[i], 0, `byte ${i} should be zero-filled`);
});

test("readChunk: a chunk entirely past the end of memory is all zero", () => {
  const memory = new WebAssembly.Memory({ initial: 8 }); // less than one full chunk
  const chunk0 = readChunk(memory, 0, memoryPageCount(memory));
  assert.equal(chunk0.length, CHUNK_BYTES);
  assert.ok(chunk0.every((byte) => byte === 0));
});

// ---- chunksToWrite ----------------------------------------------------------

test("chunksToWrite: a changed page maps to an upsert of its chunk", () => {
  const hashes = new Map([[5, 111]]); // page 5, chunk 0, still non-zero
  const diff = { changed: [[5, new Uint8Array(PAGE_BYTES)]], removed: [] };
  const { upsert, remove } = chunksToWrite(diff, hashes);
  assert.deepEqual(upsert, [0]);
  assert.deepEqual(remove, []);
});

test("chunksToWrite: a removed page inside a still non-zero chunk is an upsert, not a delete", () => {
  // Page 20 (chunk 1) went to zero, but page 17 (also chunk 1) is still
  // non-zero -- the chunk row must be rewritten (to drop page 20's bytes),
  // not deleted.
  const hashes = new Map([[17, 222]]);
  const diff = { changed: [], removed: [20] };
  const { upsert, remove } = chunksToWrite(diff, hashes);
  assert.deepEqual(upsert, [1]);
  assert.deepEqual(remove, []);
});

test("chunksToWrite: a chunk whose every page went to zero is a delete", () => {
  // Pages 0 and 1 (both chunk 0) both went to zero; nothing else in chunk 0
  // is in `hashes`.
  const hashes = new Map([[16, 333]]); // unrelated page in chunk 1
  const diff = { changed: [], removed: [0, 1] };
  const { upsert, remove } = chunksToWrite(diff, hashes);
  assert.deepEqual(upsert, []);
  assert.deepEqual(remove, [0]);
});

test("chunksToWrite: changed and removed pages in different chunks are independent", () => {
  const hashes = new Map([[5, 1]]); // chunk 0 still has a non-zero page
  const diff = {
    changed: [[5, new Uint8Array(PAGE_BYTES)]], // chunk 0 -> upsert
    removed: [32, 33], // chunk 2, all gone -> remove
  };
  const { upsert, remove } = chunksToWrite(diff, hashes);
  assert.deepEqual(upsert, [0]);
  assert.deepEqual(remove, [2]);
});

test("chunksToWrite: a first snapshot upserts every chunk that has a non-zero page", () => {
  const hashes = new Map([
    [0, 1],
    [16, 2],
    [17, 3],
  ]);
  const diff = {
    changed: [
      [0, new Uint8Array(PAGE_BYTES)],
      [16, new Uint8Array(PAGE_BYTES)],
      [17, new Uint8Array(PAGE_BYTES)],
    ],
    removed: [],
  };
  const { upsert, remove } = chunksToWrite(diff, hashes);
  assert.deepEqual(upsert, [0, 1]);
  assert.deepEqual(remove, []);
});

// ---- chunk-store round trip through the unmodified restore functions ------
//
// This is the same shape runtime/sandbox.mjs's _ensureInstance builds: take
// a snapshot, split it into 1 MiB chunks (readChunk), simulate storing and
// reading back the chunks table, and hand restoreJavaScriptSession/
// restoreEmbeddedSession a chunk-keyed readPage closure -- proving those
// functions (unmodified: they just call readPage(page) for every page and
// writePage() whatever's truthy) work unchanged against the new storage
// shape.

function captureAsChunks(session) {
  const snap = session.snapshot();
  const diff = diffPages(snap.memory, new Map());
  const memoryPages = memoryPageCount(snap.memory);
  const { upsert } = chunksToWrite(diff, diff.hashes);
  const chunkStore = new Map(upsert.map((chunk) => [chunk, readChunk(snap.memory, chunk, memoryPages)]));
  return {
    handle: snap.handle,
    extra: snap.extra,
    memoryPages,
    readPage: (page) => {
      const chunk = chunkStore.get(chunkOf(page));
      if (!chunk) return undefined;
      const offset = (page % CHUNK_PAGES) * PAGE_BYTES;
      return chunk.subarray(offset, offset + PAGE_BYTES);
    },
  };
}

const jsModule = new WebAssembly.Module(
  readFileSync(new URL("../packages/javascript/dist/engine.wasm", import.meta.url)),
);
const pythonModule = new WebAssembly.Module(readFileSync("packages/python/dist/engine.wasm"));
const pythonArchive = readFileSync("packages/python/dist/stdlib.bin");
const perlModule = new WebAssembly.Module(readFileSync("packages/perl/dist/engine.wasm"));
const perlArchive = readFileSync("packages/perl/dist/stdlib.bin");

test("javascript: a chunk-store snapshot restores correctly (readPage sliced from 1 MiB chunks)", () => {
  const workspace = new Workspace();
  const session = createJavaScriptSession(jsModule, { workspace, cwd: "/workspace" });
  session.execute({ code: "var counter = 1; function greet(name) { return 'hi ' + name; }" });
  assert.equal(session.canSnapshot(), true);

  const snapshot = captureAsChunks(session);
  const restored = restoreJavaScriptSession(jsModule, {
    workspace: new Workspace(),
    cwd: "/workspace",
    snapshot,
  });
  const result = restored.execute({ code: "counter + 1 + '/' + greet('world')" });
  assert.deepEqual(result.results, [{ text: "'2/hi world'" }]);
});

test("python: a chunk-store snapshot restores correctly (readPage sliced from 1 MiB chunks)", () => {
  const workspace = new Workspace();
  const session = createEmbeddedSession(pythonModule, pythonArchive, "python", {
    workspace,
    cwd: "/workspace",
  });
  session.execute({ code: "counter = 1\ndef greet(name):\n    return 'hi ' + name\n" });
  assert.equal(session.canSnapshot(), true);

  const snapshot = captureAsChunks(session);
  const restored = restoreEmbeddedSession(pythonModule, pythonArchive, "python", {
    workspace: new Workspace(),
    cwd: "/workspace",
    snapshot,
  });
  const result = restored.execute({ code: "counter + 1" });
  assert.deepEqual(result.results, [{ text: "2" }]);
  const called = restored.execute({ code: "greet('world')" });
  assert.deepEqual(called.results, [{ text: "'hi world'" }]);
});

test("perl: a chunk-store snapshot restores correctly (readPage sliced from 1 MiB chunks)", () => {
  const workspace = new Workspace();
  const session = createEmbeddedSession(perlModule, perlArchive, "perl", {
    workspace,
    cwd: "/workspace",
  });
  session.execute({ code: "our $counter = 1; sub greet { return 'hi ' . $_[0]; } 1;" });
  assert.equal(session.canSnapshot(), true);

  const snapshot = captureAsChunks(session);
  const restored = restoreEmbeddedSession(perlModule, perlArchive, "perl", {
    workspace: new Workspace(),
    cwd: "/workspace",
    snapshot,
  });
  const result = restored.execute({ code: "$counter + 1" });
  assert.deepEqual(result.results, [{ text: "2" }]);
  const called = restored.execute({ code: "greet('world')" });
  assert.deepEqual(called.results, [{ text: "hi world" }]);
});
