// Pure-Node tests for phase 2 of durable sessions (memory snapshots): taking
// a snapshot from a live session, restoring a brand-new session instance
// from it (with a fresh Workspace object, as a Durable Object does after
// eviction), and canSnapshot()/page-diff behavior. See
// docs/sessions-design.md and @sandbox-workers/interpreter/snapshot.
//
// Unlike tests/engine.test.mjs / tests/languages.test.mjs (one process-wide
// module per language), this file also measures a snapshot's own cost, so it
// loads each engine.wasm itself rather than sharing state with those files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createJavaScriptSession,
  restoreJavaScriptSession,
} from "../packages/javascript/src/engine.mjs";
import { bootWasmifySession, restoreWasmifySession } from "@sandbox-workers/interpreter/wasmify";
import { pythonDriver } from "../packages/python/src/engine.mjs";
import { perlDriver } from "../packages/perl/src/engine.mjs";
import { Workspace } from "@sandbox-workers/core";
import { diffPages, memoryPageCount, PAGE_BYTES } from "@sandbox-workers/interpreter/snapshot";

// Each engine's own fuel limit (packages/<lang>/src/metadata.ts `limits.fuel`),
// inlined here rather than importing the built dist/metadata.js so this test
// file doesn't need `build:packages` to have run first.
const JAVASCRIPT_LIMITS = { fuel: 50_000_000 };
const PYTHON_LIMITS = { fuel: 100_000_000 };
const PERL_LIMITS = { fuel: 10_000_000 };

const jsModule = new WebAssembly.Module(
  readFileSync(new URL("../packages/javascript/dist/engine.wasm", import.meta.url)),
);
const pythonModule = new WebAssembly.Module(readFileSync("packages/python/dist/engine.wasm"));
const pythonArchive = readFileSync("packages/python/dist/stdlib.bin");
const perlModule = new WebAssembly.Module(readFileSync("packages/perl/dist/engine.wasm"));
const perlArchive = readFileSync("packages/perl/dist/stdlib.bin");

// Full first snapshot: diffPages() against an empty hash map returns every
// non-zero page already copied out, which is exactly what a from-scratch
// restore needs (a Durable Object taking its first snapshot does the same
// thing — see @sandbox-workers/interpreter's server.ts's ensureInstance/executeInContextImpl).
function captureSnapshot(session) {
  const snap = session.snapshot();
  const diff = diffPages(snap.memory, new Map());
  const store = new Map(diff.changed);
  return {
    handle: snap.handle,
    extra: snap.extra,
    memoryPages: memoryPageCount(snap.memory),
    readPage: (page) => store.get(page),
    pageCount: store.size,
  };
}

// ---- JavaScript -----------------------------------------------------------

test("javascript: a snapshot restores into a brand-new session with a fresh workspace", () => {
  const workspace = new Workspace();
  const session = createJavaScriptSession(jsModule, { workspace, cwd: "/workspace" }, JAVASCRIPT_LIMITS);
  session.execute({
    code: "var counter = 1; function greet(name) { return 'hi ' + name; } class Box { constructor(v) { this.v = v; } get() { return this.v; } }",
  });
  assert.equal(session.canSnapshot(), true);

  const start = performance.now();
  const snapshot = captureSnapshot(session);
  const snapshotMs = performance.now() - start;
  assert.ok(snapshot.pageCount > 0);

  const freshWorkspace = new Workspace();
  const restored = restoreJavaScriptSession(
    jsModule,
    { workspace: freshWorkspace, cwd: "/workspace" },
    snapshot,
    JAVASCRIPT_LIMITS,
  );
  const result = restored.execute({ code: "counter + 1 + '/' + greet('world') + '/' + new Box(42).get()" });
  assert.deepEqual(result.results, [{ text: "'2/hi world/42'" }]);

  // A further import(), from the fresh workspace, still works after restore.
  freshWorkspace.write("/workspace/lib.mjs", "/workspace", "export const v = 7;");
  const imported = restored.execute({ code: 'const m = await import("./lib.mjs"); m.v' });
  assert.deepEqual(imported.results, [{ text: "7" }]);

  console.log(`javascript: first snapshot took ${snapshotMs.toFixed(2)} ms (${snapshot.pageCount} pages)`);
});

test("javascript: canSnapshot() is true after a fuel interrupt", () => {
  const workspace = new Workspace();
  const session = createJavaScriptSession(jsModule, { workspace, cwd: "/workspace" }, JAVASCRIPT_LIMITS);
  session.execute({ code: "var survivor = 1" });
  const looped = session.execute({ code: "while (true) {}" });
  assert.equal(looped.error.name, "ExecutionLimitError");
  assert.equal(session.invalid, false);
  assert.equal(session.canSnapshot(), true);
  const after = session.execute({ code: "survivor" });
  assert.deepEqual(after.results, [{ text: "1" }]);
});

test("javascript: page diff reports only the pages that actually changed", () => {
  const workspace = new Workspace();
  const session = createJavaScriptSession(jsModule, { workspace, cwd: "/workspace" }, JAVASCRIPT_LIMITS);
  session.execute({ code: "var a = 1;" });
  const snap1 = session.snapshot();
  const first = diffPages(snap1.memory, new Map());
  assert.ok(first.hashes.size > 0);

  session.execute({ code: "var smallChange = 2;" });
  const snap2 = session.snapshot();
  const second = diffPages(snap2.memory, first.hashes);
  assert.ok(second.changed.length > 0, "at least one page changed");
  assert.ok(
    second.changed.length < first.hashes.size,
    "a small eval should not touch every page that was already hashed",
  );

  const measured = performance.now();
  const incremental = diffPages(session.snapshot().memory, second.hashes);
  const incrementalMs = performance.now() - measured;
  assert.equal(incremental.changed.length, 0); // nothing ran since `second`
  console.log(`javascript: incremental (no-op) diff took ${incrementalMs.toFixed(2)} ms`);
});

// ---- Python -----------------------------------------------------------

test("python: a snapshot restores into a brand-new session with a fresh workspace", () => {
  const workspace = new Workspace();
  const session = bootWasmifySession(
    pythonModule,
    pythonArchive,
    pythonDriver,
    { workspace, cwd: "/workspace" },
    PYTHON_LIMITS,
  );
  session.execute({ code: "counter = 1\ndef greet(name):\n    return 'hi ' + name\n" });
  assert.equal(session.canSnapshot(), true);

  const start = performance.now();
  const snapshot = captureSnapshot(session);
  const snapshotMs = performance.now() - start;
  assert.ok(snapshot.pageCount > 0);

  const freshWorkspace = new Workspace();
  const restored = restoreWasmifySession(
    pythonModule,
    pythonArchive,
    pythonDriver,
    { workspace: freshWorkspace, cwd: "/workspace" },
    snapshot,
    PYTHON_LIMITS,
  );
  const result = restored.execute({ code: "counter + 1" });
  assert.deepEqual(result.results, [{ text: "2" }]);
  const called = restored.execute({ code: "greet('world')" });
  assert.deepEqual(called.results, [{ text: "'hi world'" }]);

  // A further `import`, from the fresh workspace, still works after restore.
  freshWorkspace.write("/workspace/lib2.py", "/workspace", "z = 9\n");
  const imported = restored.execute({ code: "import lib2\nlib2.z" });
  assert.deepEqual(imported.results, [{ text: "9" }]);

  console.log(`python: first snapshot took ${snapshotMs.toFixed(2)} ms (${snapshot.pageCount} pages)`);
});

test("python: canSnapshot() is false after a fuel trap", () => {
  const workspace = new Workspace();
  const session = bootWasmifySession(
    pythonModule,
    pythonArchive,
    pythonDriver,
    { workspace, cwd: "/workspace" },
    PYTHON_LIMITS,
  );
  session.execute({ code: "x = 1" });
  assert.equal(session.canSnapshot(), true);
  const looped = session.execute({ code: "while True: pass" });
  assert.equal(looped.error.name, "ExecutionLimitError");
  assert.equal(session.canSnapshot(), false);
  assert.equal(session.invalid, true);
});

test("python: Math.random-equivalent caveat — random is re-seeded after restore", () => {
  // random.seed() is called once by restoreWasmifySession's afterRestore
  // hook (pythonDriver.afterRestore); this just checks the restored
  // interpreter is still functional and `random` still imports and produces
  // a value (not that any particular value comes out).
  const workspace = new Workspace();
  const session = bootWasmifySession(
    pythonModule,
    pythonArchive,
    pythonDriver,
    { workspace, cwd: "/workspace" },
    PYTHON_LIMITS,
  );
  session.execute({ code: "import random" });
  const snapshot = captureSnapshot(session);
  const restored = restoreWasmifySession(
    pythonModule,
    pythonArchive,
    pythonDriver,
    { workspace: new Workspace(), cwd: "/workspace" },
    snapshot,
    PYTHON_LIMITS,
  );
  const result = restored.execute({ code: "0 <= random.random() < 1" });
  assert.deepEqual(result.results, [{ text: "True" }]);
});

// ---- Perl -----------------------------------------------------------

test("perl: a snapshot restores into a brand-new session with a fresh workspace", () => {
  const workspace = new Workspace();
  const session = bootWasmifySession(
    perlModule,
    perlArchive,
    perlDriver,
    { workspace, cwd: "/workspace" },
    PERL_LIMITS,
  );
  session.execute({ code: "our $counter = 1; sub greet { return 'hi ' . $_[0]; } 1;" });
  assert.equal(session.canSnapshot(), true);

  const start = performance.now();
  const snapshot = captureSnapshot(session);
  const snapshotMs = performance.now() - start;
  assert.ok(snapshot.pageCount > 0);

  const freshWorkspace = new Workspace();
  const restored = restoreWasmifySession(
    perlModule,
    perlArchive,
    perlDriver,
    { workspace: freshWorkspace, cwd: "/workspace" },
    snapshot,
    PERL_LIMITS,
  );
  const result = restored.execute({ code: "$counter + 1" });
  assert.deepEqual(result.results, [{ text: "2" }]);
  const called = restored.execute({ code: "greet('world')" });
  assert.deepEqual(called.results, [{ text: "hi world" }]);

  // Loading a module after restore still works (a fresh "import").
  const used = restored.execute({ code: "use List::Util qw(max); max(1, 5, 3);" });
  assert.deepEqual(used.results, [{ text: "5" }]);

  console.log(`perl: first snapshot took ${snapshotMs.toFixed(2)} ms (${snapshot.pageCount} pages)`);
});

test("perl: canSnapshot() is false after a fuel trap", () => {
  const workspace = new Workspace();
  const session = bootWasmifySession(
    perlModule,
    perlArchive,
    perlDriver,
    { workspace, cwd: "/workspace" },
    PERL_LIMITS,
  );
  session.execute({ code: "our $x = 1;" });
  assert.equal(session.canSnapshot(), true);
  const looped = session.execute({ code: "while(1) {}" });
  assert.equal(looped.error.name, "ExecutionLimitError");
  assert.equal(session.canSnapshot(), false);
  assert.equal(session.invalid, true);
});

// ---- canSnapshot(): open file descriptors ---------------------------------

test("python: canSnapshot() is false while the guest holds an open file descriptor", () => {
  const workspace = new Workspace();
  const session = bootWasmifySession(
    pythonModule,
    pythonArchive,
    pythonDriver,
    { workspace, cwd: "/workspace" },
    PYTHON_LIMITS,
  );
  session.execute({ code: 'open("/workspace/x.txt", "w").write("hi")' }); // closed via GC/refcounting normally, but...
  // Explicitly keep a handle open across the execute() boundary via a global.
  session.execute({ code: '__leaked_fh = open("/workspace/x.txt")' });
  assert.equal(session.canSnapshot(), false);
  session.execute({ code: "__leaked_fh.close()" });
  assert.equal(session.canSnapshot(), true);
});
