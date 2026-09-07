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
 * DELETE /interpreters/<key>, and POST /execute (stateless) over `fetch` --
 * plus the `executeInContext(key, args, getFiles)` RPC method the real
 * runtime Worker forwards to its Interpreter Durable Object (see
 * runtime/interpreter.mjs), reusing the real `Workspace` class for the
 * mirror-reconciliation / pull contract. `calls` records HTTP calls;
 * `executeCalls` records each `executeInContext` call's `args`;
 * `getFilesCalls` records the `paths` array passed to each `getFiles` call.
 */
function makeInterpreter({ language, engine, contexts = true }) {
  let mirror = new Workspace();
  const contextsById = new Map();
  const calls = [];
  const executeCalls = [];
  const getFilesCalls = [];
  // Records what `getFiles` answered for the disabled-File-API probe (see
  // "workspace.disabled === true" below), so a test can assert the sandbox
  // answered `[]` rather than pulling anything real.
  const disabledPulls = [];
  // Hook for the "getFiles returns fewer entries than asked" test: applied
  // to whatever `getFiles` returns before the interpreter validates/applies it.
  let transformPulled = (pulled) => pulled;

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

    const deleteMatch = /^\/interpreters\/[^/]+$/.exec(path);
    if (method === "DELETE" && deleteMatch) {
      contextsById.clear();
      mirror = new Workspace();
      return jsonResponse({ success: true });
    }

    return errorResponse(404, "VALIDATION_FAILED", "Not found");
  }

  // Mirrors runtime/interpreter.mjs's `_executeInContext`: reconcile against
  // the manifest, pull whatever's missing via `getFiles`, run the "guest
  // program" (a tiny JSON command interpreted directly against the mirror,
  // so tests can drive concrete workspace mutations without a real Wasm
  // engine), and return `{ ok, ... }` -- never throws.
  async function executeInContext(key, args, getFiles) {
    executeCalls.push({ key, args });
    const context = contextsById.get(args.contextId);
    if (!context) {
      return {
        ok: false,
        status: 404,
        body: errorBody(404, "CONTEXT_NOT_FOUND", `Code context '${args.contextId}' not found`, {
          contextId: args.contextId,
        }),
      };
    }
    if (args.workspace.disabled === true) {
      // The File API is disabled: nothing to reconcile against (`dirs`/
      // `manifest` are always empty) -- probe `getFiles` anyway to confirm
      // the sandbox answers `[]` rather than pulling anything real.
      const pulled = await getFiles(["/workspace/probe.txt"]);
      disabledPulls.push(pulled);
    } else {
      let { missing } = mirror.applySync({
        dirs: args.workspace.dirs,
        files: [],
        manifest: args.workspace.manifest,
      });
      if (missing.length > 0) {
        getFilesCalls.push(missing);
        const pulled = transformPulled(await getFiles(missing));
        ({ missing } = mirror.applySync({ dirs: args.workspace.dirs, files: pulled, manifest: args.workspace.manifest }));
        if (missing.length > 0) {
          return {
            ok: false,
            status: 500,
            body: errorBody(500, "INTERNAL_ERROR", `Sandbox did not provide ${missing.length} workspace file(s)`),
          };
        }
      }
    }

    const since = mirror.changes().snapshot;
    const command = JSON.parse(args.code);
    const results = [];
    if (command.op === "write") {
      mirror.write(command.path, "/workspace", command.content ?? "");
    } else if (command.op === "mkdir") {
      mirror.mkdir(command.path, "/workspace", { recursive: !!command.recursive });
    } else if (command.op === "read") {
      results.push({ text: mirror.read(command.path, "/workspace").content });
    } else if (command.op === "error") {
      return { ok: true, result: buildGuestErrorResult(args, context) };
    } else if (command.op === "noop") {
      // nothing
    }
    const fileDiff = mirror.changes(since);
    context.executions++;
    const files = [...fileDiff.created, ...fileDiff.updated].map((p) => {
      const { data, updatedAt } = mirror.readBytes(p, "/workspace");
      return { path: p, data, updatedAt };
    });
    return {
      ok: true,
      result: {
        code: args.code,
        language,
        engine,
        durationMs: 0,
        logs: { stdout: [], stderr: [] },
        results,
        executionCount: context.executions,
        context: { id: args.contextId, cwd: context.cwd, executions: context.executions, snapshot: null },
        workspace: { dirs: mirror.manifest().dirs, files, deleted: fileDiff.deleted },
      },
    };
  }

  // A guest-level error (no throw): the response carries no workspace
  // changes at all (mirroring runtime/interpreter.mjs's restoreFrom(before)).
  function buildGuestErrorResult(args, context) {
    return {
      code: args.code,
      language,
      engine,
      durationMs: 0,
      logs: { stdout: [], stderr: [] },
      results: [],
      error: { name: "EngineError", message: "guest error", traceback: [] },
      executionCount: context.executions,
      context: { id: args.contextId, cwd: context.cwd, executions: context.executions, snapshot: null },
      workspace: { dirs: mirror.manifest().dirs, files: [], deleted: [] },
    };
  }

  return {
    fetch,
    executeInContext,
    calls,
    executeCalls,
    getFilesCalls,
    disabledPulls,
    contextsById,
    resetMirror() {
      mirror = new Workspace();
    },
    forgetContext(id) {
      contextsById.delete(id);
    },
    setPulledFilesTransform(fn) {
      transformPulled = fn;
    },
  };
}

function errorBody(status, code, message, context = {}) {
  return { code, message, context, httpStatus: status, timestamp: new Date().toISOString() };
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
function errorCmd() {
  return JSON.stringify({ op: "error" });
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

test("first execute after a fresh sandbox pulls every file exactly once", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hello" });
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/b.txt", content: "world" });

  const res = await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  assert.equal(res.status, 200);
  assert.equal(js.getFilesCalls.length, 1, "exactly one getFiles call");
  assert.deepEqual(
    js.getFilesCalls[0].slice().sort(),
    ["/workspace/a.txt", "/workspace/b.txt"],
    "the one call lists every file",
  );
  // The manifest sent alongside is always the shape of /workspace, not its contents.
  const sentArgs = js.executeCalls.at(-1).args;
  assert.deepEqual(Object.keys(sentArgs.workspace.manifest).sort(), ["/workspace/a.txt", "/workspace/b.txt"]);
  assert.equal(sentArgs.workspace.files, undefined, "no file contents travel with the manifest");
});

test("a second execute with nothing changed makes no getFiles call", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hello" });
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });

  js.getFilesCalls.length = 0;
  const res = await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  assert.equal(res.status, 200);
  assert.equal(js.getFilesCalls.length, 0);
});

test("writeFile of one file then execute pulls only that path", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hello" });
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });

  js.getFilesCalls.length = 0;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/b.txt", content: "world" });
  const res = await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  assert.equal(res.status, 200);
  assert.equal(js.getFilesCalls.length, 1);
  assert.deepEqual(js.getFilesCalls[0], ["/workspace/b.txt"]);
});

test("simulated interpreter eviction: the next execute pulls everything again, with no state on the sandbox side", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hello" });
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });

  // The interpreter's own mirror is lost (e.g. its Durable Object was
  // evicted); the sandbox has no "sent" cache to invalidate -- it always
  // sends the manifest and lets the interpreter ask for what it's missing.
  js.resetMirror();
  js.getFilesCalls.length = 0;
  const res = await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  assert.equal(res.status, 200);
  assert.equal(js.getFilesCalls.length, 1, "a single getFiles call, no retry/resync round trip");
  assert.deepEqual(js.getFilesCalls[0], ["/workspace/a.txt"]);
});

test("getFiles returning fewer entries than asked -> 500 INTERNAL_ERROR", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hello" });

  js.setPulledFilesTransform(() => []);
  const res = await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });
  assert.equal(res.status, 500);
  assert.equal(res.body.code, "INTERNAL_ERROR");
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

test("a guest error still leaves the sandbox's tree unchanged", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/before.txt", content: "before" });
  await call(sandbox, "POST", "/execute", { code: noopCmd(), contextId: ctx.id });

  const execRes = await call(sandbox, "POST", "/execute", { code: errorCmd(), contextId: ctx.id });
  assert.equal(execRes.status, 200);
  assert.ok(execRes.body.error);

  const list = await call(sandbox, "POST", "/files", { op: "list", path: "/workspace" });
  assert.deepEqual(
    list.body.files.map((f) => f.absolutePath),
    ["/workspace/before.txt"],
  );
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
  const execCall = js.executeCalls.at(-1);
  assert.deepEqual(execCall.args.envVars, { A: "sandbox-a", B: "context-b", D: "call-d" });
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
  const pyExec = py.executeCalls.at(-1);
  assert.ok(pyExec.args.workspace.dirs.includes("/workspace/emptydir"));

  // Also visible through the files API.
  const list = await call(sandbox, "POST", "/files", { op: "list", path: "/workspace" });
  assert.ok(list.body.files.some((f) => f.absolutePath === "/workspace/emptydir" && f.type === "directory"));
});

// ---- SANDBOX_FILE_API=disabled ----------------------------------------------

test("SANDBOX_FILE_API=disabled: POST /files -> 403 NOT_SUPPORTED", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js, SANDBOX_FILE_API: "disabled" } });

  const res = await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hi" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "NOT_SUPPORTED");
  assert.equal(res.body.context.feature, "files");
});

test("SANDBOX_FILE_API=disabled: execute sends an empty/disabled workspace, getFiles answers [], nothing persists", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox, db } = makeSandbox({ env: { JAVASCRIPT: js, SANDBOX_FILE_API: "disabled" } });

  const ctx = (await call(sandbox, "POST", "/contexts", { binding: "JAVASCRIPT" })).body;
  const res = await call(sandbox, "POST", "/execute", {
    code: writeCmd("/workspace/a.txt", "x"),
    contextId: ctx.id,
  });
  assert.equal(res.status, 200);

  const sentArgs = js.executeCalls.at(-1).args;
  assert.deepEqual(sentArgs.workspace, { dirs: [], manifest: {}, disabled: true });
  assert.deepEqual(js.disabledPulls, [[]]);

  const info = await call(sandbox, "GET", "/");
  assert.equal(info.body.fileApi, false);
  assert.deepEqual(info.body.workspace, { files: 0, bytes: 0 });
  assert.equal(info.body.contexts[0].executions, 1);

  assert.equal(db.prepare("SELECT count(*) AS n FROM files").get().n, 0);

  const res2 = await call(sandbox, "POST", "/execute", {
    code: writeCmd("/workspace/a.txt", "x"),
    contextId: ctx.id,
  });
  assert.equal(res2.status, 200);
  const info2 = await call(sandbox, "GET", "/");
  assert.equal(info2.body.contexts[0].executions, 2);
});

test("default env: GET / has fileApi === true", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js } });
  const info = await call(sandbox, "GET", "/");
  assert.equal(info.body.fileApi, true);
});

test("SANDBOX_FILE_API set to any other value behaves as enabled", async () => {
  const js = makeInterpreter({ language: "javascript", engine: "SpiderMonkey" });
  const { sandbox } = makeSandbox({ env: { JAVASCRIPT: js, SANDBOX_FILE_API: "enabled" } });

  const res = await call(sandbox, "POST", "/files", { op: "write", path: "/workspace/a.txt", content: "hi" });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});
