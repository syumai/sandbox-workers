// Pure Node tests for `InterpreterServer` (packages/interpreter/src/server.ts)
// against a fake, Wasm-free `Engine`: a `SessionInstance` backed by a real
// `WebAssembly.Memory` holding a 4-byte counter, snapshotted/restored the
// same way a real engine's memory is. Exercises the session-contract
// normalization (tmp/interpreter-core-split-design.md section 4 + phase 3's
// "Session-contract normalisation") end to end: booting/restoring from the
// `chunks` table, the ExecutionLimitError-skips-snapshot rule, `invalid`
// dropping the resident, and a guest error rolling the workspace mirror
// back.
//
// Imports `InterpreterServer`/`createTestState` directly from their built
// files rather than the package's `.` entry point: the entry point also
// re-exports `InterpreterWorker`/`InterpreterDurableObject`, which import
// `cloudflare:workers` -- not resolvable under plain Node. Run
// `pnpm --filter @sandbox-workers/interpreter build` first (and
// `@sandbox-workers/core build`, which it depends on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { InterpreterServer } from "../packages/interpreter/dist/server.js";
import { createTestState } from "../packages/interpreter/dist/testing.js";
import { INTERPRETER_KEY_HEADER, MAX_CONTEXTS, Workspace } from "../packages/core/dist/index.js";

const PAGE_BYTES = 65536;
const KEY = "sbx-key-1";

// ---- fake Engine: a counter kept in a real WebAssembly.Memory -------------

function makeSessionInstance(options, initial) {
  let cwd = options.cwd;
  let counter = initial.counter;
  const memory = initial.memory ?? new WebAssembly.Memory({ initial: 2 });
  const handle = initial.handle;
  let closed = false;
  let invalid = false;

  const writeCounter = () => new DataView(memory.buffer).setUint32(0, counter, true);
  writeCounter();

  return {
    get cwd() {
      return cwd;
    },
    get invalid() {
      return invalid;
    },
    close() {
      closed = true;
    },
    canSnapshot() {
      return !closed && !invalid;
    },
    snapshot() {
      writeCounter();
      return { handle, extra: {}, memory };
    },
    execute({ code }) {
      const cmd = JSON.parse(code);
      const ok = (extra = {}) => ({ logs: { stdout: [], stderr: [] }, results: [{ text: String(counter) }], cwd, ...extra });
      switch (cmd.op) {
        case "inc":
          counter++;
          writeCounter();
          return ok();
        case "read":
          return ok();
        case "chdir":
          cwd = cmd.cwd;
          options.onCwdChange?.(cwd);
          return ok();
        case "write":
          options.workspace.write(cmd.path, cwd, cmd.content ?? "");
          if (cmd.thenError)
            return ok({ error: { name: "EngineError", message: "write then guest error", traceback: [] } });
          return ok();
        case "error":
          return ok({ error: { name: "EngineError", message: "guest error", traceback: [] } });
        case "limit":
          // A resource limit: some work happened (the counter still moves,
          // matching a real engine's partial progress before an interrupt is
          // observed) but the instance survives and this round must NOT be
          // snapshotted -- so the on-disk record stays stale/behind memory
          // until a later, non-limited round. InterpreterServer must skip
          // the snapshot for this round without dropping the resident.
          counter++;
          writeCounter();
          return ok({ error: { name: "ExecutionLimitError", message: "fuel exhausted", traceback: [] } });
        case "invalidate":
          // A hard invalidation NOT tagged as a resource limit (e.g. a
          // Python/Perl-style trap unrelated to fuel): InterpreterServer
          // must drop the resident because `invalid` is now true, not
          // because of the error's name.
          invalid = true;
          return ok({ error: { name: "EngineError", message: "fatal", traceback: [] } });
        default:
          throw new Error(`unknown op ${cmd.op}`);
      }
    },
  };
}

function makeEngine({ build = "test-build-1" } = {}) {
  return {
    language: "counter",
    engineName: "Counter Test Engine",
    build,
    limits: { fuel: 0, memoryBytes: 0, codeBytes: 65536, requestBytes: 98304 },
    run() {
      return { logs: { stdout: [], stderr: [] }, results: [{ text: "stateless" }] };
    },
    sessions: {
      boot: (options) => makeSessionInstance(options, { handle: 1n, counter: 0 }),
      restore: (options, snapshot) => {
        const memory = new WebAssembly.Memory({ initial: snapshot.memoryPages });
        for (let page = 0; page < snapshot.memoryPages; page++) {
          const data = snapshot.readPage(page);
          if (data) new Uint8Array(memory.buffer, page * PAGE_BYTES, PAGE_BYTES).set(data);
        }
        const counter = new DataView(memory.buffer).getUint32(0, true);
        return makeSessionInstance(options, { handle: snapshot.handle, counter, memory });
      },
    },
  };
}

// ---- helpers ----------------------------------------------------------------

function makeServer({ db, id = "interpreter-1", env = {}, engine = makeEngine() } = {}) {
  const state = createTestState({ db, id });
  return new InterpreterServer(state, env, () => engine);
}

function httpRequest(method, path, { key = KEY, body } = {}) {
  const headers = new Headers();
  if (key !== undefined) headers.set(INTERPRETER_KEY_HEADER, key);
  const init = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`https://interpreter.internal${path}`, init);
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function inc() {
  return JSON.stringify({ op: "inc" });
}
function readCmd() {
  return JSON.stringify({ op: "read" });
}
function writeCmd(path, content, thenError = false) {
  return JSON.stringify({ op: "write", path, content, thenError });
}
function errorCmd() {
  return JSON.stringify({ op: "error" });
}
function limitCmd() {
  return JSON.stringify({ op: "limit" });
}
function invalidateCmd() {
  return JSON.stringify({ op: "invalidate" });
}

/** A fake "sandbox-side" workspace this interpreter's mirror reconciles against. */
function makeSandboxSide() {
  const workspace = new Workspace();
  const getFilesCalls = [];
  const getFiles = async (paths) => {
    getFilesCalls.push(paths);
    return paths
      .filter((p) => {
        try {
          workspace.stat(p, "/workspace");
          return true;
        } catch {
          return false;
        }
      })
      .map((p) => {
        const { data, updatedAt } = workspace.readBytes(p, "/workspace");
        return { path: p, data, updatedAt };
      });
  };
  const manifestArgs = () => {
    const m = workspace.manifest();
    return { dirs: m.dirs, manifest: m.files };
  };
  return { workspace, getFiles, getFilesCalls, manifestArgs };
}

async function createContext(server, id = "ctx-1", key = KEY) {
  return readJson(await server.fetch(httpRequest("POST", "/contexts", { key, body: { id } })));
}

// ---- tests --------------------------------------------------------------

test("POST /contexts creates a context (201), rejects a duplicate id, and enforces the 8-context cap", async () => {
  const server = makeServer();
  const created = await createContext(server, "ctx-1");
  assert.equal(created.id, "ctx-1");
  assert.equal(created.cwd, "/workspace");
  assert.ok(created.createdAt);

  const dup = await server.fetch(httpRequest("POST", "/contexts", { body: { id: "ctx-1" } }));
  assert.equal(dup.status, 400);
  const dupBody = await readJson(dup);
  assert.match(dupBody.message, /already exists/);

  for (let i = 2; i <= MAX_CONTEXTS; i++) await createContext(server, `ctx-${i}`);
  const overflow = await server.fetch(httpRequest("POST", "/contexts", { body: { id: "ctx-overflow" } }));
  assert.equal(overflow.status, 400);
  const overflowBody = await readJson(overflow);
  assert.match(overflowBody.message, new RegExp(`Cannot create more than ${MAX_CONTEXTS}`));
});

test("execute() result shape: context.snapshot populated, workspace diff reports the write", async () => {
  const server = makeServer();
  await createContext(server, "ctx-1");
  const sandbox = makeSandboxSide();

  // "inc" first so the counter (memory page 0) is non-zero -- hashMemory()
  // skips all-zero pages, so a write-only round would report zero snapshot
  // pages even though a snapshot was taken.
  await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  const res = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: writeCmd("/workspace/out.txt", "hi"), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(res.ok, true);
  assert.equal(res.result.context.id, "ctx-1");
  assert.equal(res.result.context.executions, 2);
  assert.ok(res.result.context.snapshot, "a snapshot record is present");
  assert.equal(res.result.context.snapshot.build, "test-build-1");
  assert.equal(res.result.context.snapshot.stale, false);
  assert.ok(res.result.context.snapshot.pages > 0);
  assert.deepEqual(
    res.result.workspace.files.map((f) => f.path),
    ["/workspace/out.txt"],
  );
});

test("eviction: a second InterpreterServer over the same storage restores from chunks and the counter continues", async () => {
  const db = new DatabaseSync(":memory:");
  const engine = makeEngine();
  const server1 = makeServer({ db, engine });
  await createContext(server1, "ctx-1");
  const sandbox = makeSandboxSide();

  const first = await server1.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(first.result.results[0].text, "1");

  // A brand-new InterpreterServer instance (simulating eviction) over the
  // same underlying storage, with an empty in-memory workspace mirror --
  // reconciliation pulls everything again.
  const server2 = makeServer({ db, engine });
  const second = await server2.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(second.result.results[0].text, "2", "the counter survived the restore from chunks");
});

test("a stored snapshot with a stale build boots fresh instead of restoring", async () => {
  const db = new DatabaseSync(":memory:");
  const sandbox = makeSandboxSide();
  const server1 = makeServer({ db, engine: makeEngine({ build: "build-a" }) });
  await createContext(server1, "ctx-1");
  await server1.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );

  const server2 = makeServer({ db, engine: makeEngine({ build: "build-b" }) });
  const res = await server2.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(res.result.results[0].text, "1", "booted fresh: counter did not continue from the old build's snapshot");
  assert.equal(res.result.context.snapshot.build, "build-b");
});

test("an ExecutionLimitError outcome skips the snapshot for that round and keeps the resident instance", async () => {
  const server = makeServer();
  await createContext(server, "ctx-1");
  const sandbox = makeSandboxSide();

  const first = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  const snapshotAfterFirst = first.result.context.snapshot;
  assert.ok(snapshotAfterFirst);

  const limited = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: limitCmd(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(limited.result.error.name, "ExecutionLimitError");
  // No new snapshot was taken this round (no snapshotMs reported), and the
  // stored record is untouched.
  assert.equal(limited.result.context.snapshotMs, undefined);
  assert.deepEqual(limited.result.context.snapshot, snapshotAfterFirst);

  // The "limit" round itself moved the counter to 2 in memory without
  // snapshotting it (the stored record above is still the counter-1
  // snapshot). If the resident had been dropped and restored from that
  // stale record instead of kept alive, the next "inc" would land on 2, not
  // 3 -- so this distinguishes "kept the instance" from "rebooted from the
  // stale snapshot" (both of which would otherwise look identical from a
  // fresh boot's counter alone).
  const after = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(after.result.results[0].text, "3", "the resident instance was kept, not rebooted from the stale snapshot");
});

test("instance.invalid drops the resident even when the error isn't ExecutionLimitError", async () => {
  const server = makeServer();
  await createContext(server, "ctx-1");
  const sandbox = makeSandboxSide();

  await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  const invalidated = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: invalidateCmd(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(invalidated.result.error.name, "EngineError");
  // The dropped-resident branch never marks the existing snapshot stale (it
  // still describes a genuinely valid prior state) -- if the resident had
  // NOT been dropped, `live` would be the (canSnapshot()-false) invalid
  // instance, which server.ts's rule 3 else-branch would instead read as
  // "there's a live resident that just can't be snapshotted right now" and
  // mark the on-disk record `stale: true`.
  assert.equal(invalidated.result.context.snapshot.stale, false);

  // The resident was dropped: the next call boots fresh, restoring from
  // whatever was last snapshotted (build matches, so it restores from the
  // pre-invalidation snapshot: counter 1) rather than reusing any in-memory
  // state the invalidate() call itself produced.
  const after = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: inc(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(after.result.results[0].text, "2", "restored from the last good snapshot (counter 1), then incremented");
});

test("a guest error rolls the workspace mirror back", async () => {
  const server = makeServer();
  await createContext(server, "ctx-1");
  const sandbox = makeSandboxSide();

  await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: writeCmd("/workspace/before.txt", "before"), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  sandbox.workspace.write("/workspace/before.txt", "/workspace", "before");

  const res = await server.executeInContext(
    KEY,
    {
      contextId: "ctx-1",
      code: writeCmd("/workspace/after.txt", "should not persist", true),
      envVars: {},
      workspace: sandbox.manifestArgs(),
    },
    sandbox.getFiles,
  );
  assert.ok(res.result.error);
  // fileDiff is null on a guest error (restoreFrom(before) rolled the
  // mirror back before the diff was ever computed), so the response
  // reports no changes at all -- not even the file this round tried (and
  // failed) to persist.
  assert.deepEqual(res.result.workspace.files, []);
  assert.deepEqual(res.result.workspace.deleted, []);
});

test("executeInContext against a missing context id -> { ok: false, body.code: CONTEXT_NOT_FOUND }", async () => {
  const server = makeServer();
  const sandbox = makeSandboxSide();
  const res = await server.executeInContext(
    KEY,
    { contextId: "does-not-exist", code: readCmd(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "CONTEXT_NOT_FOUND");
});

test("an invalid interpreter key -> 400, over both fetch() and executeInContext()", async () => {
  const server = makeServer();
  const badFetch = await server.fetch(httpRequest("POST", "/contexts", { key: "not a valid key!", body: { id: "x" } }));
  assert.equal(badFetch.status, 400);

  const sandbox = makeSandboxSide();
  const badRpc = await server.executeInContext(
    "not a valid key!",
    { contextId: "ctx-1", code: readCmd(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(badRpc.ok, false);
  assert.equal(badRpc.status, 400);
});

test("DELETE / wipes storage: a context created before it is gone after", async () => {
  const server = makeServer();
  await createContext(server, "ctx-1");

  const del = await server.fetch(httpRequest("DELETE", "/"));
  assert.equal(del.status, 200);
  assert.deepEqual(await readJson(del), { success: true });

  const deleteCtx = await server.fetch(httpRequest("DELETE", "/contexts/ctx-1"));
  assert.equal(deleteCtx.status, 404);
  const body = await readJson(deleteCtx);
  assert.equal(body.code, "CONTEXT_NOT_FOUND");
});

test("alarm() destroys once the idle TTL has passed", async () => {
  const server = makeServer({ env: { INTERPRETER_IDLE_TTL_MS: "1" } });
  await createContext(server, "ctx-1");

  // The alarm was armed (throttling always fires on the first touch); wait
  // past the 1 ms TTL so alarm()'s own re-check computes a past deadline.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server.alarm();

  const deleteCtx = await server.fetch(httpRequest("DELETE", "/contexts/ctx-1"));
  assert.equal(deleteCtx.status, 404, "the context is gone: alarm() destroyed the interpreter");
});

test("workspace reconciliation pulls only missing paths via getFiles, and rejects an unrequested path", async () => {
  const server = makeServer();
  await createContext(server, "ctx-1");
  const sandbox = makeSandboxSide();
  sandbox.workspace.write("/workspace/a.txt", "/workspace", "a");
  sandbox.workspace.write("/workspace/b.txt", "/workspace", "b");

  const first = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: readCmd(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(first.ok, true);
  assert.equal(sandbox.getFilesCalls.length, 1);
  assert.deepEqual(sandbox.getFilesCalls[0].slice().sort(), ["/workspace/a.txt", "/workspace/b.txt"]);

  sandbox.getFilesCalls.length = 0;
  sandbox.workspace.write("/workspace/c.txt", "/workspace", "c");
  const second = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: readCmd(), envVars: {}, workspace: sandbox.manifestArgs() },
    sandbox.getFiles,
  );
  assert.equal(second.ok, true);
  assert.deepEqual(sandbox.getFilesCalls, [["/workspace/c.txt"]], "only the newly-changed path was pulled");

  // A getFiles that answers with a path nobody asked for is rejected outright.
  sandbox.workspace.write("/workspace/d.txt", "/workspace", "d");
  const untrustedGetFiles = async (paths) => [
    ...(await sandbox.getFiles(paths)),
    { path: "/workspace/b.txt", data: new TextEncoder().encode("tampered"), updatedAt: Date.now() },
  ];
  const rejected = await server.executeInContext(
    KEY,
    { contextId: "ctx-1", code: readCmd(), envVars: {}, workspace: sandbox.manifestArgs() },
    untrustedGetFiles,
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 500);
  assert.equal(rejected.body.code, "INTERNAL_ERROR");
});
