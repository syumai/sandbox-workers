// Pure Node tests for the caller-hosted `Sandbox` Durable Object
// (packages/core/src/sandbox.ts; see docs/sandbox-1-0-design.md). Drives the
// class directly through fetch()/alarm() with a fake `state` backed by
// node:sqlite's DatabaseSync (wrapped to the same `exec(query, ...params)`
// shape the real Durable Object SQLite storage exposes) and fake runtime
// bindings that record/replay `/interpreter` and `/interpreters/...`
// requests. Run `pnpm --filter @sandbox-workers/core build` first; this
// imports the built package, not the TypeScript source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Sandbox, Workspace } from "../packages/core/dist/index.js";

// ---- fake DurableObjectState (node:sqlite-backed) --------------------------

function isSelect(query) {
  return /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
}

/**
 * Builds a fake `state` over a shared `node:sqlite` DatabaseSync, so multiple
 * `Sandbox` instances can be constructed against "the same DB" (to test that
 * persisted state survives eviction). `id` is fixed per DB, matching a real
 * Durable Object's stable `ctx.id`.
 */
function makeState(db, id = "sandbox-key-1") {
  let alarm = null;
  return {
    id: { toString: () => id },
    storage: {
      sql: {
        exec(query, ...params) {
          const stmt = db.prepare(query);
          if (isSelect(query)) return stmt.all(...params);
          stmt.run(...params);
          return [];
        },
      },
      transactionSync(fn) {
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      async deleteAll() {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all();
        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(time) {
        alarm = time instanceof Date ? time.getTime() : time;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
    async blockConcurrencyWhile(fn) {
      return fn();
    },
  };
}

function makeSandbox({ env = {}, id = "sandbox-key-1", db } = {}) {
  const database = db ?? new DatabaseSync(":memory:");
  const state = makeState(database, id);
  return { sandbox: new Sandbox(state, env), db: database };
}

// ---- fake runtime bindings --------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function errorResponse(status, code, message, context = {}) {
  return jsonResponse(
    { code, message, context, httpStatus: status, timestamp: new Date().toISOString() },
    status,
  );
}

/**
 * A fake runtime Worker + interpreter Durable Object for one language:
 * serves GET /interpreter, POST/DELETE /interpreters/<key>/contexts[/:id],
 * POST /interpreters/<key>/execute (with the same mirror-reconciliation /
 * resync contract as runtime/interpreter.mjs, reusing the real `Workspace`
 * class), DELETE /interpreters/<key>, and POST /execute (stateless).
 */
function makeInterpreter({ language, engine, contexts = true }) {
  let mirror = new Workspace();
  const contextsById = new Map();
  const calls = [];

  async function fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const hasBody = method !== "GET" && method !== "DELETE";
    const bodyText = hasBody ? await request.text() : undefined;
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ method, path, body });

    if (method === "GET" && path === "/interpreter") return jsonResponse({ language, engine, contexts });

    if (!contexts) {
      if (method === "POST" && path === "/execute") {
        return jsonResponse({
          code: body.code,
          language,
          engine,
          durationMs: 0,
          logs: { stdout: [], stderr: [] },
          results: [{ json: { envVars: body.envVars ?? {} } }],
        });
      }
      return errorResponse(400, "VALIDATION_FAILED", "Code contexts are not supported");
    }

    const contextsMatch = /^\/interpreters\/[^/]+\/contexts$/.exec(path);
    if (method === "POST" && contextsMatch) {
      if (contextsById.size >= 8)
        return errorResponse(400, "VALIDATION_FAILED", "Cannot create more than 8 code contexts");
      contextsById.set(body.id, { cwd: body.cwd, executions: 0 });
      return jsonResponse({ id: body.id, cwd: body.cwd, createdAt: new Date().toISOString() }, 201);
    }

    const deleteContextMatch = /^\/interpreters\/[^/]+\/contexts\/([^/]+)$/.exec(path);
    if (method === "DELETE" && deleteContextMatch) {
      const id = decodeURIComponent(deleteContextMatch[1]);
      if (!contextsById.has(id))
        return errorResponse(404, "CONTEXT_NOT_FOUND", `Code context '${id}' not found`, { contextId: id });
      contextsById.delete(id);
      return jsonResponse({ success: true });
    }

    const executeMatch = /^\/interpreters\/[^/]+\/execute$/.exec(path);
    if (method === "POST" && executeMatch) {
      const context = contextsById.get(body.contextId);
      if (!context)
        return errorResponse(404, "CONTEXT_NOT_FOUND", `Code context '${body.contextId}' not found`, {
          contextId: body.contextId,
        });
      const { missing } = mirror.applySync({
        dirs: body.workspace.dirs,
        files: body.workspace.files,
        manifest: body.workspace.manifest,
      });
      if (missing.length > 0) return jsonResponse({ resync: true, missing });

      const since = mirror.changes().snapshot;
      // The "guest program" is a tiny JSON command interpreted directly
      // against the mirror, so tests can drive concrete workspace mutations
      // without a real Wasm engine.
      const command = JSON.parse(body.code);
      const results = [];
      if (command.op === "write") {
        mirror.write(command.path, "/workspace", command.content ?? "");
      } else if (command.op === "mkdir") {
        mirror.mkdir(command.path, "/workspace", { recursive: !!command.recursive });
      } else if (command.op === "read") {
        results.push({ text: mirror.read(command.path, "/workspace").content });
      } else if (command.op === "noop") {
        // nothing
      }
      const fileDiff = mirror.changes(since);
      context.executions++;
      const files = [...fileDiff.created, ...fileDiff.updated].map((p) => {
        const read = mirror.read(p, "/workspace", { encoding: "base64" });
        return { path: p, data: read.content, updatedAt: read.updatedAt };
      });
      return jsonResponse({
        code: body.code,
        language,
        engine,
        durationMs: 0,
        logs: { stdout: [], stderr: [] },
        results,
        executionCount: context.executions,
        context: { id: body.contextId, cwd: context.cwd, executions: context.executions, snapshot: null },
        workspace: { dirs: mirror.manifest().dirs, files, deleted: fileDiff.deleted },
      });
    }

    const deleteMatch = /^\/interpreters\/[^/]+$/.exec(path);
    if (method === "DELETE" && deleteMatch) {
      contextsById.clear();
      mirror = new Workspace();
      return jsonResponse({ success: true });
    }

    return errorResponse(404, "VALIDATION_FAILED", "Not found");
  }

  return {
    fetch,
    calls,
    contextsById,
    resetMirror() {
      mirror = new Workspace();
    },
    forgetContext(id) {
      contextsById.delete(id);
    },
  };
}

/** A binding whose GET /interpreter answers non-JSON: not a sandbox-workers runtime Worker. */
function makeNonRuntimeBinding() {
  return {
    async fetch() {
      return new Response("<html>hi</html>", { headers: { "content-type": "text/html" } });
    },
  };
}

function writeCmd(path, content) {
  return JSON.stringify({ op: "write", path, content });
}
function mkdirCmd(path, recursive) {
  return JSON.stringify({ op: "mkdir", path, recursive });
}
function noopCmd() {
  return JSON.stringify({ op: "noop" });
}

// ---- request helper ---------------------------------------------------------

async function call(sandbox, method, path, body, sandboxId = "sbx-1") {
  const headers = { "x-sandbox-id": sandboxId };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await sandbox.fetch(new Request(`https://sandbox.internal${path}`, init));
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

// ---- tests ------------------------------------------------------------------

test("unknown binding: createCodeContext -> 400 VALIDATION_FAILED", async () => {
  const { sandbox } = makeSandbox({ env: {} });
  const res = await call(sandbox, "POST", "/contexts", { binding: "NOPE" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_FAILED");
  assert.match(res.body.message, /Unknown binding 'NOPE'/);
});

test("binding that isn't a runtime (non-JSON GET /interpreter) -> 400", async () => {
  const { sandbox } = makeSandbox({ env: { WEIRD: makeNonRuntimeBinding() } });
  const res = await call(sandbox, "POST", "/contexts", { binding: "WEIRD" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_FAILED");
  assert.match(res.body.message, /not a sandbox-workers runtime Worker/);
});

test("context creation and GET /contexts", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const created = await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT", cwd: "/workspace" });
  assert.equal(created.status, 201);
  assert.equal(created.body.binding, "JAVASCRIPT");
  assert.equal(created.body.language, "javascript");
  assert.equal(created.body.cwd, "/workspace");
  assert.ok(created.body.id);

  const list = await call(sandbox, "GET", "/contexts");
  assert.equal(list.status, 200);
  assert.equal(list.body.contexts.length, 1);
  assert.equal(list.body.contexts[0].id, created.body.id);
  assert.equal(list.body.contexts[0].binding, "JAVASCRIPT");

  // The interpreter itself was told to register the context, keyed by the
  // sandbox's own id.
  assert.equal(js.calls.filter((c) => c.method === "POST" && /\/contexts$/.test(c.path)).length, 1);
});

test("default context is reused per binding and created only once", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });

  const r1 = await call(sandbox, "POST", "/execute", { code: noopCmd(), binding: "JAVASCRIPT" });
  assert.equal(r1.status, 200);
  const ctxId = r1.body.context.id;

  const r2 = await call(sandbox, "POST", "/execute", { code: noopCmd(), binding: "JAVASCRIPT" });
  assert.equal(r2.body.context.id, ctxId);

  const list = await call(sandbox, "GET", "/contexts");
  assert.equal(list.body.contexts.length, 1);
});

test("contexts: false binding: runCode falls back to stateless /execute, no context in response; createCodeContext -> 400", async () => {
  const ruby = makeInterpreter({ language: "ruby", engine: "MRI-ish", contexts: false });
  const { sandbox } = makeSandbox({ env: { RUBY: ruby } });

  const ctxRes = await call(sandbox, "POST", "/contexts", { binding: "RUBY" });
  assert.equal(ctxRes.status, 400);
  assert.match(ctxRes.body.message, /Code contexts are not supported by binding 'RUBY'/);

  await call(sandbox, "POST", "/env", { envVars: { GREETING: "hi" } });
  const execRes = await call(sandbox, "POST", "/execute", { code: "1+1", binding: "RUBY" });
  assert.equal(execRes.status, 200);
  assert.equal(execRes.body.context, undefined);
  assert.equal(execRes.body.language, "ruby");

  const statelessCall = ruby.calls.find((c) => c.path === "/execute");
  assert.ok(statelessCall);
  assert.deepEqual(statelessCall.body.envVars, { GREETING: "hi" });
});

test("execute sync payload: full manifest on first call, only changed files on the next; empty files when nothing changed", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;

  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hello" });

  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  const firstExec = js.calls.find((c) => /\/execute$/.test(c.path));
  assert.deepEqual(Object.keys(firstExec.body.workspace.manifest), ["/workspace/a.txt"]);
  assert.equal(firstExec.body.workspace.files.length, 1);
  assert.equal(firstExec.body.workspace.files[0].path, "/workspace/a.txt");

  js.calls.length = 0;
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  const secondExec = js.calls.find((c) => /\/execute$/.test(c.path));
  assert.deepEqual(secondExec.body.workspace.files, []);
  assert.deepEqual(Object.keys(secondExec.body.workspace.manifest), ["/workspace/a.txt"]);

  js.calls.length = 0;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/b.txt", content: "world" });
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  const thirdExec = js.calls.find((c) => /\/execute$/.test(c.path));
  assert.equal(thirdExec.body.workspace.files.length, 1);
  assert.equal(thirdExec.body.workspace.files[0].path, "/workspace/b.txt");
});

test("resync retry: interpreter reports missing files, sandbox resends with them added", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hello" });
  // Establish `sent` for this binding.
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });

  // Simulate the interpreter losing its mirror (eviction) while the sandbox
  // still believes it holds /workspace/a.txt.
  js.resetMirror();
  js.calls.length = 0;
  const res = await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  assert.equal(res.status, 200);

  const execCalls = js.calls.filter((c) => /\/execute$/.test(c.path));
  assert.equal(execCalls.length, 2, "one resync response, one retry with the missing file");
  assert.deepEqual(execCalls[0].body.workspace.files, []);
  assert.equal(execCalls[1].body.workspace.files.length, 1);
  assert.equal(execCalls[1].body.workspace.files[0].path, "/workspace/a.txt");
});

test("response workspace is applied, visible through POST /files, and persisted across a fresh Sandbox instance", async () => {
  const db = new DatabaseSync(":memory:");
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js }, db });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;

  const execRes = await call(sandbox, "POST", "/execute", {
    code: writeCmd("/workspace/out.txt", "produced by the guest"),
    contextId: ctx.id,
  });
  assert.equal(execRes.status, 200);

  const read = await call(sandbox, "POST", "/files", { op: "read", path: "/workspace/out.txt" });
  assert.equal(read.status, 200);
  assert.equal(read.body.content, "produced by the guest");

  const list = await call(sandbox, "POST", "/files", { op: "list", path: "/workspace" });
  assert.ok(list.body.files.some((f) => f.absolutePath === "/workspace/out.txt"));

  // A fresh Sandbox instance over the same underlying DB sees the persisted file.
  const { sandbox: sandbox2 } = makeSandbox({ env: { JAVASCRIPT: js }, db });
  const read2 = await call(sandbox2, "POST", "/files", { op: "read", path: "/workspace/out.txt" });
  assert.equal(read2.body.content, "produced by the guest");
});

test("CONTEXT_NOT_FOUND from the runtime -> 404, and the context disappears from GET /contexts", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;

  // The interpreter forgot this context (e.g. its own idle expiry fired)
  // without the sandbox knowing.
  js.forgetContext(ctx.id);

  const res = await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "CONTEXT_NOT_FOUND");

  const list = await call(sandbox, "GET", "/contexts");
  assert.equal(list.body.contexts.length, 0);
});

test("envVars merge order: sandbox, then context, then call; null/undefined unset", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  await call(sandbox, "POST", "/env", { envVars: { A: "sandbox-a", B: "sandbox-b", C: "sandbox-c" } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT", envVars: { B: "context-b" } }))
    .body;

  await call(sandbox, "POST", "/execute", {
    code: noopCmd(),
    contextId: ctx.id,
    envVars: { C: null, D: "call-d" },
  });
  const execCall = js.calls.find((c) => /\/execute$/.test(c.path));
  assert.deepEqual(execCall.body.envVars, { A: "sandbox-a", B: "context-b", D: "call-d" });
});

test("GET / info shape", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  await call(sandbox, "POST", "/env", { envVars: { A: "1" } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/execute", {
    code: writeCmd("/workspace/x.txt", "hi"),
    contextId: ctx.id,
  });

  const info = await call(sandbox, "GET", "/");
  assert.equal(info.status, 200);
  assert.equal(info.body.id, "sbx-1");
  assert.deepEqual(info.body.envVars, { A: "1" });
  assert.equal(info.body.contexts.length, 1);
  assert.equal(info.body.contexts[0].binding, "JAVASCRIPT");
  assert.equal(info.body.contexts[0].language, "javascript");
  assert.equal(info.body.contexts[0].executions, 1);
  assert.equal(typeof info.body.workspace.files, "number");
  assert.equal(typeof info.body.workspace.bytes, "number");
  assert.ok(info.body.expiresAt === null || typeof info.body.expiresAt === "number");
});

test("DELETE / calls DELETE /interpreters/<key> on each distinct binding referenced by a context", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const py = makeInterpreter({ language: "python", engine: "CPython-ish" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js, PYTHON: py } });
  await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" });
  await call(sandbox, "POST", "/contexts", { binding: "PYTHON" });

  const res = await call(sandbox, "DELETE", "/");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true });

  assert.ok(js.calls.some((c) => c.method === "DELETE" && /^\/interpreters\/[^/]+$/.test(c.path)));
  assert.ok(py.calls.some((c) => c.method === "DELETE" && /^\/interpreters\/[^/]+$/.test(c.path)));

  const list = await call(sandbox, "GET", "/contexts");
  assert.equal(list.body.contexts.length, 0);
});

test("an empty directory created by mkdir reaches the sync payload's dirs on the next execute (including a different binding)", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const py = makeInterpreter({ language: "python", engine: "CPython-ish" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js, PYTHON: py } });
  const jsCtx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;

  await call(sandbox, "POST", "/execute", {
    code: mkdirCmd("/workspace/emptydir", false),
    contextId: jsCtx.id,
  });

  // A brand-new binding (PYTHON) has never seen this sandbox's workspace:
  // its first execute must carry the full directory list, including the
  // guest-created empty directory.
  const pyCtx = (await call(sandbox, "POST", "/contexts", { binding: "PYTHON" })).body;
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: pyCtx.id });
  const pyExec = py.calls.find((c) => /\/execute$/.test(c.path));
  assert.ok(pyExec.body.workspace.dirs.includes("/workspace/emptydir"));

  // Also visible through the files API.
  const list = await call(sandbox, "POST", "/files", { op: "list", path: "/workspace" });
  assert.ok(list.body.files.some((f) => f.absolutePath === "/workspace/emptydir" && f.type === "directory"));
});
