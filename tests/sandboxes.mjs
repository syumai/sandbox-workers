// HTTP tests for durable sandboxes (code contexts), run like tests/http.mjs
// against a running gateway (SANDBOX_URL). The gateway forwards
// /languages/:language/sandboxes/:id/... to its own Sandbox Durable Object
// (keyed by :id), forcing binding = :language.toUpperCase() on
// POST .../contexts and POST .../execute (see src/index.ts,
// docs/sandbox-1-0-design.md, "Gateway (Playground) and UI").
import assert from "node:assert/strict";

const base = process.env.SANDBOX_URL ?? "http://localhost:8787";
let checks = 0;

function sandboxUrl(language, id, subpath = "") {
  return `${base}/languages/${language}/sandboxes/${id}${subpath}`;
}

async function execute(language, id, body, status = 200) {
  const res = await fetch(sandboxUrl(language, id, "/execute"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, status, `execute ${language}/${id}: unexpected status`);
  checks++;
  return res.json();
}

async function files(language, id, body, status = 200) {
  const res = await fetch(sandboxUrl(language, id, "/files"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, status, `files ${language}/${id}: unexpected status`);
  checks++;
  return res.json();
}

async function createContext(language, id, body = {}, status = 201) {
  const res = await fetch(sandboxUrl(language, id, "/contexts"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, status, `createContext ${language}/${id}: unexpected status`);
  checks++;
  return res.json();
}

async function listContexts(language, id) {
  const res = await fetch(sandboxUrl(language, id, "/contexts"));
  assert.equal(res.status, 200);
  checks++;
  return res.json();
}

async function deleteContext(language, id, contextId, status = 200) {
  const res = await fetch(sandboxUrl(language, id, `/contexts/${contextId}`), { method: "DELETE" });
  assert.equal(res.status, status, `deleteContext ${language}/${id}/${contextId}: unexpected status`);
  checks++;
  return res.json();
}

async function setEnv(language, id, envVars, status = 200) {
  const res = await fetch(sandboxUrl(language, id, "/env"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envVars }),
  });
  assert.equal(res.status, status, `setEnv ${language}/${id}: unexpected status`);
  checks++;
  return res.json();
}

async function info(language, id) {
  const res = await fetch(sandboxUrl(language, id));
  assert.equal(res.status, 200);
  checks++;
  return res.json();
}

async function destroy(language, id) {
  const res = await fetch(sandboxUrl(language, id), { method: "DELETE" });
  assert.equal(res.status, 200);
  checks++;
  return res.json();
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const fileApi = (await info("javascript", uniqueId("probe"))).fileApi !== false;
console.log(`file API ${fileApi ? "enabled" : "disabled"} on ${base}`);
// The Playground's own wrangler.jsonc now sets SANDBOX_FILE_API=disabled, so
// this probe determines which branch below to run. To exercise the enabled
// branch, start a second dev server without that var and point this file at
// it:
//
//   pnpm exec wrangler dev -c wrangler.jsonc -c engine/wrangler.jsonc -c engine/wrangler-python.jsonc \
//     -c engine/wrangler-perl.jsonc -c engine/wrangler-ruby.jsonc --var SANDBOX_FILE_API:enabled --port 8797
//   SANDBOX_URL=http://localhost:8797 node tests/sandboxes.mjs

// ---- JavaScript: default context REPL semantics ------------------------

{
  const id = uniqueId("js-basic");
  const r1 = await execute("javascript", id, { code: "var counter = 1; counter" });
  assert.deepEqual(r1.results, [{ text: "1" }]);
  assert.equal(typeof r1.context.id, "string");
  assert.equal(r1.executionCount, 1);
  assert.equal(r1.context.executions, 1);
  const r2 = await execute("javascript", id, { code: "counter += 1; counter" });
  assert.deepEqual(r2.results, [{ text: "2" }]);
  assert.equal(r2.context.executions, 2);
  // Context-less executes always resolve to the same default context.
  assert.equal(r1.context.id, r2.context.id);
  console.log("javascript: variable persists across calls; default context is reused");
}

{
  const id = uniqueId("js-letconst");
  await execute("javascript", id, {
    code: "let letValue = 10; const constValue = 20; class Greeter { hi() { return 'hi'; } }",
  });
  const r = await execute("javascript", id, {
    code: "letValue + constValue + new Greeter().hi().length",
  });
  assert.deepEqual(r.results, [{ text: "32" }]);
  console.log("javascript: let/const/class persist across calls");
}

{
  const id = uniqueId("js-await");
  await execute("javascript", id, {
    code: "let awaited = 5; await Promise.resolve(); awaited",
  });
  const r = await execute("javascript", id, { code: "awaited" });
  assert.deepEqual(r.results, [{ text: "5" }]);
  console.log("javascript: top-level await still persists declarations");
}

{
  const id = uniqueId("js-fs");
  if (fileApi) {
    await execute("javascript", id, {
      code: 'fs.writeFileSync("/workspace/from-guest.txt", "hello from guest")',
    });
    const readViaApi = await files("javascript", id, { op: "read", path: "/workspace/from-guest.txt" });
    assert.equal(readViaApi.content, "hello from guest");

    await files("javascript", id, {
      op: "write",
      path: "/workspace/from-api.txt",
      content: "hello from api",
    });
    const readViaGuest = await execute("javascript", id, {
      code: 'fs.readFileSync("/workspace/from-api.txt", "utf8")',
    });
    assert.deepEqual(readViaGuest.results, [{ text: "'hello from api'" }]);
    console.log("javascript: files written by guest/API are visible to each other");
  } else {
    const writeDenied = await files(
      "javascript",
      id,
      { op: "write", path: "/workspace/x.txt", content: "x" },
      403,
    );
    assert.equal(writeDenied.code, "NOT_SUPPORTED");
    const listDenied = await files("javascript", id, { op: "list", path: "/workspace" }, 403);
    assert.equal(listDenied.code, "NOT_SUPPORTED");

    const writeAttempt = await execute("javascript", id, {
      code: '(() => { try { fs.writeFileSync("/workspace/a.txt", "x"); return "wrote" } catch (e) { return e.code } })()',
    });
    assert.deepEqual(writeAttempt.results, [{ text: "'EACCES'" }]);
    const readAttempt = await execute("javascript", id, {
      code: '(() => { try { fs.readFileSync("/workspace/a.txt", "utf8"); return "read" } catch (e) { return e.code } })()',
    });
    assert.deepEqual(readAttempt.results, [{ text: "'EACCES'" }]);
    const cwdResult = await execute("javascript", id, { code: "process.cwd()" });
    assert.deepEqual(cwdResult.results, [{ text: "'/workspace'" }]);

    const shown = await info("javascript", id);
    assert.equal(shown.fileApi, false);
    assert.deepEqual(shown.workspace, { files: 0, bytes: 0 });
    console.log(
      "javascript: the File API is disabled -- /files rejects with 403 NOT_SUPPORTED, guest fs access is EACCES, and /workspace stays empty",
    );
  }
}

{
  const id = uniqueId("js-cwd");
  if (fileApi) {
    await execute("javascript", id, { code: 'fs.mkdirSync("/workspace/sub"); process.chdir("sub")' });
    const r = await execute("javascript", id, { code: "process.cwd()" });
    assert.deepEqual(r.results, [{ text: "'/workspace/sub'" }]);
    assert.equal(r.context.cwd, "/workspace/sub");
    console.log("javascript: cwd persists after process.chdir, reported on context.cwd");
  }
}

{
  const id = uniqueId("js-import");
  if (fileApi) {
    await execute("javascript", id, {
      code: 'fs.writeFileSync("/workspace/lib.mjs", "export const val = 99;")',
    });
    const r = await execute("javascript", id, { code: 'const m = await import("./lib.mjs"); m.val' });
    assert.deepEqual(r.results, [{ text: "99" }]);
    console.log('javascript: import("./lib.mjs") is served from the workspace');
  }
}

{
  // transformForRepl strips TypeScript-only syntax the same way
  // transformForAsyncExecution does for the stateless /execute path (acorn
  // first, sucrase fallback), and the declaration still persists on the
  // context's real global across calls.
  const id = uniqueId("js-typescript");
  await execute("javascript", id, { code: "const n: number = 41;" });
  const r = await execute("javascript", id, { code: "n + 1" });
  assert.deepEqual(r.results, [{ text: "42" }]);
  console.log("javascript: a TypeScript declaration persists across context calls");
}

// ---- Python --------------------------------------------------------------

{
  const id = uniqueId("py-basic");
  await execute("python", id, { code: "counter = 1" });
  const r = await execute("python", id, { code: "counter + 1" });
  assert.deepEqual(r.results, [{ text: "2" }]);
  console.log("python: variable persists across calls");
}

{
  const id = uniqueId("py-fs");
  if (fileApi) {
    await execute("python", id, {
      code: 'open("/workspace/from-guest.txt", "w").write("hello from guest")',
    });
    const readViaApi = await files("python", id, { op: "read", path: "/workspace/from-guest.txt" });
    assert.equal(readViaApi.content, "hello from guest");
    await files("python", id, { op: "write", path: "/workspace/from-api.txt", content: "hello from api" });
    const readViaGuest = await execute("python", id, {
      code: 'open("/workspace/from-api.txt").read()',
    });
    assert.deepEqual(readViaGuest.results, [{ text: "'hello from api'" }]);
    console.log("python: files written by guest/API are visible to each other");
  } else {
    const writeDenied = await files(
      "python",
      id,
      { op: "write", path: "/workspace/x.txt", content: "x" },
      403,
    );
    assert.equal(writeDenied.code, "NOT_SUPPORTED");
    const listDenied = await files("python", id, { op: "list", path: "/workspace" }, 403);
    assert.equal(listDenied.code, "NOT_SUPPORTED");

    const writeAttempt = await execute("python", id, {
      code: 'try:\n    open("/workspace/a.txt", "w")\nexcept PermissionError as e:\n    r = "perm"\nr',
    });
    assert.deepEqual(writeAttempt.results, [{ text: "'perm'" }]);
    const readAttempt = await execute("python", id, {
      code: 'try:\n    open("/workspace/a.txt")\nexcept PermissionError as e:\n    r = "perm"\nr',
    });
    assert.deepEqual(readAttempt.results, [{ text: "'perm'" }]);
    const cwdResult = await execute("python", id, { code: "import os\nos.getcwd()" });
    assert.deepEqual(cwdResult.results, [{ text: "'/workspace'" }]);

    const shown = await info("python", id);
    assert.equal(shown.fileApi, false);
    assert.deepEqual(shown.workspace, { files: 0, bytes: 0 });
    console.log(
      "python: the File API is disabled -- /files rejects with 403 NOT_SUPPORTED, guest fs access raises PermissionError, and /workspace stays empty",
    );
  }
}

{
  const id = uniqueId("py-cwd");
  if (fileApi) {
    await execute("python", id, { code: 'import os\nos.mkdir("/workspace/sub")\nos.chdir("sub")' });
    const r = await execute("python", id, { code: "import os\nos.getcwd()" });
    assert.deepEqual(r.results, [{ text: "'/workspace/sub'" }]);
    assert.equal(r.context.cwd, "/workspace/sub");
    console.log("python: cwd persists after os.chdir");
  }
}

{
  const id = uniqueId("py-import");
  if (fileApi) {
    await execute("python", id, {
      code: 'open("/workspace/lib.py", "w").write("val = 99\\n")',
    });
    const r = await execute("python", id, { code: "import lib\nlib.val" });
    assert.deepEqual(r.results, [{ text: "99" }]);
    console.log("python: import lib from /workspace");
  }
}

// ---- Perl ------------------------------------------------------------------

{
  const id = uniqueId("pl-basic");
  await execute("perl", id, { code: "our $counter = 1;" });
  const r = await execute("perl", id, { code: "$counter + 1;" });
  assert.deepEqual(r.results, [{ text: "2" }]);
  console.log("perl: our variable persists across calls");
}

{
  const id = uniqueId("pl-fs");
  if (fileApi) {
    await execute("perl", id, {
      code:
        'open(my $fh, ">", "/workspace/from-guest.txt") or die $!; print $fh "hello from guest"; close($fh); 1;',
    });
    const readViaApi = await files("perl", id, { op: "read", path: "/workspace/from-guest.txt" });
    assert.equal(readViaApi.content, "hello from guest");
    await files("perl", id, { op: "write", path: "/workspace/from-api.txt", content: "hello from api" });
    const readViaGuest = await execute("perl", id, {
      code:
        'open(my $fh, "<", "/workspace/from-api.txt") or die $!; my $data = do { local $/; <$fh> }; $data;',
    });
    assert.deepEqual(readViaGuest.results, [{ text: "hello from api" }]);
    console.log("perl: files written by guest/API are visible to each other");
  } else {
    const writeDenied = await files(
      "perl",
      id,
      { op: "write", path: "/workspace/x.txt", content: "x" },
      403,
    );
    assert.equal(writeDenied.code, "NOT_SUPPORTED");
    const listDenied = await files("perl", id, { op: "list", path: "/workspace" }, 403);
    assert.equal(listDenied.code, "NOT_SUPPORTED");

    const writeAttempt = await execute("perl", id, {
      code: 'open(my $fh, ">", "/workspace/a.txt") ? "ok" : "$!";',
    });
    assert.match(writeAttempt.results[0].text, /Permission denied/);

    const shown = await info("perl", id);
    assert.equal(shown.fileApi, false);
    assert.deepEqual(shown.workspace, { files: 0, bytes: 0 });
    console.log(
      "perl: the File API is disabled -- /files rejects with 403 NOT_SUPPORTED, guest fs access fails with Permission denied, and /workspace stays empty",
    );
  }
}

{
  const id = uniqueId("pl-cwd");
  if (fileApi) {
    await execute("perl", id, { code: 'mkdir("/workspace/sub"); chdir("sub") or die $!; 1;' });
    const r = await execute("perl", id, { code: "1;" });
    assert.equal(r.context.cwd, "/workspace/sub");
    console.log("perl: cwd persists after chdir");
  }
}

// ---- Ruby: no code contexts, execute stays stateless -----------------------
//
// Unlike the pre-1.0 design, the sandbox (contexts, /workspace, GET /, ...)
// is now hosted by the gateway's own Sandbox Durable Object, not by the
// runtime Worker -- so it exists for ruby too. Only binding = "RUBY" itself
// reports `contexts: false` (GET /interpreter), so creating a RUBY-bound
// context (or routing an execute to one) is what's rejected, not the
// sandbox's other routes. See docs/sandbox-1-0-design.md, "Ruby".

{
  const id = uniqueId("rb-stateless");
  const r = await execute("ruby", id, { code: "1 + 1" });
  assert.deepEqual(r.results, [{ text: "2" }]);
  assert.ok(!("context" in r), "a ruby ExecutionResult should not report a context");
  console.log("ruby: context-less execute runs statelessly with no context in the result");
}

{
  const id = uniqueId("rb-contexts");
  const res = await fetch(sandboxUrl("ruby", id, "/contexts"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.message, /not supported by binding 'RUBY'/);
  checks++;
  console.log("ruby: POST /contexts returns 400 (binding RUBY reports contexts: false)");
}

{
  const id = uniqueId("rb-execute-bogus-context");
  const res = await fetch(sandboxUrl("ruby", id, "/execute"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "1", contextId: "does-not-matter" }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, "CONTEXT_NOT_FOUND");
  checks++;
  console.log("ruby: execute with an unknown contextId is 404 CONTEXT_NOT_FOUND (context lookup is sandbox-side, language-independent)");
}

{
  const id = uniqueId("rb-info");
  const res = await fetch(sandboxUrl("ruby", id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.contexts, []);
  checks++;
  console.log("ruby: GET /languages/ruby/sandboxes/:id succeeds -- the sandbox is hosted by the gateway, not by the ruby runtime");
}

// ---- code contexts: create / list / delete --------------------------------

{
  const id = uniqueId("ctx-crud");
  const created = await createContext("javascript", id, { cwd: "/workspace", envVars: { A: "1" } });
  assert.equal(typeof created.id, "string");
  assert.equal(created.language, "javascript");
  assert.equal(created.binding, "JAVASCRIPT");
  assert.equal(created.cwd, "/workspace");
  assert.ok(!Number.isNaN(Date.parse(created.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(created.lastUsed)));

  const listed = await listContexts("javascript", id);
  assert.equal(listed.contexts.length, 1);
  assert.equal(listed.contexts[0].id, created.id);

  await deleteContext("javascript", id, created.id);
  const afterDelete = await listContexts("javascript", id);
  assert.deepEqual(afterDelete.contexts, []);

  await deleteContext("javascript", id, created.id, 404);
  console.log("javascript: contexts can be created, listed, and deleted");
}

{
  const id = uniqueId("ctx-isolation");
  const ctxA = await createContext("javascript", id, {});
  const ctxB = await createContext("javascript", id, {});
  await execute("javascript", id, { code: "var onlyInA = 1", contextId: ctxA.id });
  const checkB = await execute("javascript", id, {
    code: 'typeof onlyInA === "undefined" ? "isolated" : "leaked"',
    contextId: ctxB.id,
  });
  assert.deepEqual(checkB.results, [{ text: "'isolated'" }]);

  if (fileApi) {
    await execute("javascript", id, {
      code: 'fs.writeFileSync("/workspace/shared.txt", "from A")',
      contextId: ctxA.id,
    });
    const readFromB = await execute("javascript", id, {
      code: 'fs.readFileSync("/workspace/shared.txt", "utf8")',
      contextId: ctxB.id,
    });
    assert.deepEqual(readFromB.results, [{ text: "'from A'" }]);
    console.log("javascript: two contexts don't share globals but do share /workspace");
  } else {
    const writeFromA = await execute("javascript", id, {
      code: '(() => { try { fs.writeFileSync("/workspace/shared.txt", "from A"); return "wrote" } catch (e) { return e.code } })()',
      contextId: ctxA.id,
    });
    assert.deepEqual(writeFromA.results, [{ text: "'EACCES'" }]);
    console.log(
      "javascript: two contexts don't share globals, and /workspace writes are EACCES with the File API disabled",
    );
  }
}

{
  const id = uniqueId("ctx-default");
  const r1 = await execute("javascript", id, { code: "1" });
  const r2 = await execute("javascript", id, { code: "2" });
  assert.equal(r1.context.id, r2.context.id);
  console.log("javascript: the default context is reused across context-less executes");
}

// ---- cross-language: one sandbox id, two runtimes, one /workspace ---------
//
// docs/sandbox-1-0-design.md, "Tests": the same id reached through
// /languages/javascript/sandboxes/:id and /languages/python/sandboxes/:id is
// one sandbox with two contexts (different bindings) sharing /workspace.

{
  const id = uniqueId("cross-lang");
  if (fileApi) {
    await execute("javascript", id, {
      code: 'fs.writeFileSync("/workspace/shared.txt", "from javascript")',
    });
    const readFromPython = await execute("python", id, {
      code: 'open("/workspace/shared.txt").read()',
    });
    assert.deepEqual(readFromPython.results, [{ text: "'from javascript'" }]);

    const shown = await info("javascript", id);
    assert.equal(shown.contexts.length, 2);
    assert.deepEqual(
      shown.contexts.map((c) => c.binding).sort(),
      ["JAVASCRIPT", "PYTHON"],
    );

    const listedFromJs = await files("javascript", id, { op: "list", path: "/workspace" });
    assert.ok(listedFromJs.files.some((f) => f.name === "shared.txt"));
    const listedFromPy = await files("python", id, { op: "list", path: "/workspace" });
    assert.ok(listedFromPy.files.some((f) => f.name === "shared.txt"));

    // An empty directory created via the files API is visible to guest code
    // through either language's context.
    await files("javascript", id, { op: "mkdir", path: "/workspace/empty-dir" });
    const isDir = await execute("python", id, {
      code: 'import os\nos.path.isdir("/workspace/empty-dir")',
    });
    assert.deepEqual(isDir.results, [{ text: "True" }]);

    console.log(
      "cross-language: one sandbox id via two /languages/:language paths shares /workspace across bindings",
    );
  } else {
    await execute("javascript", id, { code: "1" });
    await execute("python", id, { code: "1" });
    const shownJs = await info("javascript", id);
    assert.equal(shownJs.fileApi, false);
    const shownPy = await info("python", id);
    assert.equal(shownPy.fileApi, false);
    console.log(
      "cross-language: both languages report fileApi === false on the same sandbox id when the File API is disabled",
    );
  }
}

// ---- setEnvVars layering ---------------------------------------------------

{
  const id = uniqueId("env-layer");
  await setEnv("javascript", id, { FOO: "sandbox" });
  const r1 = await execute("javascript", id, { code: "process.env.FOO" });
  assert.deepEqual(r1.results, [{ text: "'sandbox'" }]);

  const r2 = await execute("javascript", id, { code: "process.env.FOO", envVars: { FOO: "call" } });
  assert.deepEqual(r2.results, [{ text: "'call'" }]);

  // A later call without an override sees the sandbox-level value again.
  const r3 = await execute("javascript", id, { code: "process.env.FOO" });
  assert.deepEqual(r3.results, [{ text: "'sandbox'" }]);

  await setEnv("javascript", id, { FOO: null });
  const r4 = await execute("javascript", id, { code: "process.env.FOO ?? 'unset'" });
  assert.deepEqual(r4.results, [{ text: "'unset'" }]);
  console.log("javascript: setEnvVars layering (sandbox env, per-call override, null unsets)");
}

// ---- files: moveFile, includeHidden, FileInfo shape ------------------------

{
  const id = uniqueId("files-move");
  if (fileApi) {
    await files("javascript", id, { op: "write", path: "/workspace/a.txt", content: "hi" });
    const moved = await files("javascript", id, {
      op: "move",
      path: "/workspace/a.txt",
      newPath: "/workspace/b.txt",
    });
    assert.equal(moved.path, "/workspace/a.txt");
    assert.equal(moved.newPath, "/workspace/b.txt");
    const goneA = await files("javascript", id, { op: "exists", path: "/workspace/a.txt" });
    assert.equal(goneA.exists, false);
    const readB = await files("javascript", id, { op: "read", path: "/workspace/b.txt" });
    assert.equal(readB.content, "hi");
    console.log("javascript: moveFile behaves like rename");
  } else {
    const denied = await files("javascript", id, { op: "move", path: "/workspace/a.txt", newPath: "/workspace/b.txt" }, 403);
    assert.equal(denied.code, "NOT_SUPPORTED");
    console.log("javascript: moveFile is 403 NOT_SUPPORTED with the File API disabled");
  }
}

{
  const id = uniqueId("files-hidden");
  if (fileApi) {
    await files("javascript", id, { op: "write", path: "/workspace/visible.txt", content: "v" });
    await files("javascript", id, { op: "write", path: "/workspace/.hidden.txt", content: "h" });
    const listed = await files("javascript", id, { op: "list", path: "/workspace" });
    assert.ok(!listed.files.some((f) => f.name === ".hidden.txt"));
    const listedWithHidden = await files("javascript", id, {
      op: "list",
      path: "/workspace",
      includeHidden: true,
    });
    assert.ok(listedWithHidden.files.some((f) => f.name === ".hidden.txt"));
    console.log("javascript: includeHidden controls whether dotfiles are listed");
  } else {
    const denied = await files("javascript", id, { op: "list", path: "/workspace", includeHidden: true }, 403);
    assert.equal(denied.code, "NOT_SUPPORTED");
    console.log("javascript: list(includeHidden) is 403 NOT_SUPPORTED with the File API disabled");
  }
}

{
  const id = uniqueId("files-info");
  if (fileApi) {
    await files("javascript", id, { op: "write", path: "/workspace/info.txt", content: "abc" });
    const listed = await files("javascript", id, { op: "list", path: "/workspace" });
    const entry = listed.files.find((f) => f.name === "info.txt");
    assert.ok(entry);
    assert.equal(entry.absolutePath, "/workspace/info.txt");
    assert.equal(entry.relativePath, "info.txt");
    assert.equal(entry.type, "file");
    assert.equal(entry.size, 3);
    assert.ok(!Number.isNaN(Date.parse(entry.modifiedAt)));
    assert.equal(entry.mode, "-rw-r--r--");
    assert.deepEqual(entry.permissions, { readable: true, writable: true, executable: false });
    console.log("javascript: list() files carry the full FileInfo shape");
  } else {
    const denied = await files("javascript", id, { op: "write", path: "/workspace/info.txt", content: "abc" }, 403);
    assert.equal(denied.code, "NOT_SUPPORTED");
    console.log("javascript: files() write is 403 NOT_SUPPORTED with the File API disabled");
  }
}

// ---- deleteFile() on a directory (IS_DIRECTORY, even when empty) ----------

{
  const id = uniqueId("delete-dir");
  if (fileApi) {
    await files("javascript", id, { op: "mkdir", path: "/workspace/empty" });
    const emptyRejected = await files("javascript", id, { op: "delete", path: "/workspace/empty" }, 400);
    assert.equal(emptyRejected.code, "IS_DIRECTORY");
    assert.equal(emptyRejected.context.errno, "EISDIR");
    assert.match(emptyRejected.message, /Pass \{ recursive: true \}/);

    await files("javascript", id, { op: "mkdir", path: "/workspace/full" });
    await files("javascript", id, { op: "write", path: "/workspace/full/f.txt", content: "x" });
    const fullRejected = await files("javascript", id, { op: "delete", path: "/workspace/full" }, 400);
    assert.equal(fullRejected.code, "IS_DIRECTORY");

    await files("javascript", id, { op: "delete", path: "/workspace/empty", recursive: true });
    const emptyGone = await files("javascript", id, { op: "exists", path: "/workspace/empty" });
    assert.equal(emptyGone.exists, false);

    await files("javascript", id, { op: "delete", path: "/workspace/full", recursive: true });
    const fullGone = await files("javascript", id, { op: "exists", path: "/workspace/full" });
    assert.equal(fullGone.exists, false);
    console.log("javascript: deleteFile() refuses any directory without recursive, even an empty one");
  } else {
    const denied = await files("javascript", id, { op: "mkdir", path: "/workspace/empty" }, 403);
    assert.equal(denied.code, "NOT_SUPPORTED");
    console.log("javascript: mkdir is 403 NOT_SUPPORTED with the File API disabled");
  }
}

// ---- mkdir failure code is always FILESYSTEM_ERROR ------------------------

{
  const id = uniqueId("mkdir-codes");
  if (fileApi) {
    // FILESYSTEM_ERROR maps to HTTP 500 (see docs/sdk-parity-design.md,
    // "Errors"), so every failed mkdir below is a 500, not the errno's usual
    // status (ENOENT would normally be 404, EEXIST 409, ENOTDIR 400).
    const missingParent = await files("javascript", id, { op: "mkdir", path: "/workspace/a/b" }, 500);
    assert.equal(missingParent.code, "FILESYSTEM_ERROR");
    assert.equal(missingParent.context.errno, "ENOENT");

    await files("javascript", id, { op: "mkdir", path: "/workspace/a" });
    const existing = await files("javascript", id, { op: "mkdir", path: "/workspace/a" }, 500);
    assert.equal(existing.code, "FILESYSTEM_ERROR");
    assert.equal(existing.context.errno, "EEXIST");

    await files("javascript", id, { op: "write", path: "/workspace/notadir", content: "x" });
    const notDir = await files("javascript", id, { op: "mkdir", path: "/workspace/notadir/child" }, 500);
    assert.equal(notDir.code, "FILESYSTEM_ERROR");
    assert.equal(notDir.context.errno, "ENOTDIR");

    // mkdir with recursive: true on an existing directory still succeeds.
    const ok = await files("javascript", id, { op: "mkdir", path: "/workspace/a", recursive: true });
    assert.equal(ok.success, true);
    console.log("javascript: mkdir failures are always FILESYSTEM_ERROR, with errno kept in context.errno");
  } else {
    const denied = await files("javascript", id, { op: "mkdir", path: "/workspace/a/b" }, 403);
    assert.equal(denied.code, "NOT_SUPPORTED");
    console.log("javascript: mkdir is 403 NOT_SUPPORTED (not FILESYSTEM_ERROR) with the File API disabled");
  }
}

// ---- FileTooLargeError context carries maxSize/actualSize -----------------

{
  const id = uniqueId("too-large-ctx");
  if (fileApi) {
    const actualSize = 1024 * 1024 + 1;
    const tooLarge = await files(
      "javascript",
      id,
      { op: "write", path: "/workspace/big.bin", content: "z".repeat(actualSize) },
      413,
    );
    assert.equal(tooLarge.code, "FILE_TOO_LARGE");
    assert.equal(tooLarge.context.errno, "EFBIG");
    assert.equal(tooLarge.context.maxSize, 1024 * 1024);
    assert.equal(tooLarge.context.actualSize, actualSize);
    console.log("javascript: FileTooLargeError context carries maxSize/actualSize");
  } else {
    // With the File API disabled, an oversized write is rejected as
    // NOT_SUPPORTED (403) before size is ever checked, not FILE_TOO_LARGE (413).
    const denied = await files(
      "javascript",
      id,
      { op: "write", path: "/workspace/big.bin", content: "z".repeat(1024 * 1024 + 1) },
      403,
    );
    assert.equal(denied.code, "NOT_SUPPORTED");
    console.log("javascript: an oversized write is 403 NOT_SUPPORTED (checked before size) with the File API disabled");
  }
}

// ---- sandbox id rejection (reserved names, leading/trailing hyphen) -------

{
  for (const bad of ["www", "api", "admin", "root", "system", "cloudflare", "workers", "-abc", "abc-"]) {
    const res = await fetch(sandboxUrl("javascript", bad, "/execute"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "1" }),
    });
    assert.equal(res.status, 400, `sandbox id '${bad}' should be rejected`);
    checks++;
  }
  console.log("javascript: reserved/hyphen-boundary sandbox ids are rejected with 400");
}

// ---- "reset" (delete every context; files stay) / delete sandbox ----------

{
  const id = uniqueId("js-reset");
  await execute("javascript", id, { code: "var kept = 1" });
  if (fileApi) {
    await files("javascript", id, { op: "write", path: "/workspace/keep.txt", content: "still here" });
  }
  const before = await listContexts("javascript", id);
  for (const context of before.contexts) await deleteContext("javascript", id, context.id);
  const r = await execute("javascript", id, {
    code: 'typeof kept === "undefined" ? "cleared" : "kept"',
  });
  assert.deepEqual(r.results, [{ text: "'cleared'" }]);
  if (fileApi) {
    const stillThere = await files("javascript", id, { op: "read", path: "/workspace/keep.txt" });
    assert.equal(stillThere.content, "still here");
    console.log("javascript: deleting every context clears globals but keeps files");
  } else {
    const denied = await files("javascript", id, { op: "write", path: "/workspace/keep.txt", content: "x" }, 403);
    assert.equal(denied.code, "NOT_SUPPORTED");
    console.log("javascript: deleting every context clears globals; /files stays 403 NOT_SUPPORTED");
  }
}

{
  const id = uniqueId("js-delete");
  await execute("javascript", id, { code: "1" });
  if (fileApi) await files("javascript", id, { op: "write", path: "/workspace/gone.txt", content: "x" });
  await destroy("javascript", id);
  const afterInfo = await info("javascript", id);
  // A fresh GET after DELETE creates a brand-new sandbox record with no contexts.
  assert.deepEqual(afterInfo.contexts, []);
  if (fileApi) {
    const gone = await files("javascript", id, { op: "exists", path: "/workspace/gone.txt" });
    assert.equal(gone.exists, false);
    console.log("javascript: DELETE removes everything");
  } else {
    assert.equal(afterInfo.fileApi, false);
    console.log("javascript: DELETE removes everything (File API stays disabled)");
  }
}

// ---- memory snapshots ------------------------------------------------------

{
  const id = uniqueId("js-snapshot");
  const before = await info("javascript", id);
  assert.deepEqual(before.contexts, []);
  const r1 = await execute("javascript", id, { code: "var snapped = 1; snapped" });
  assert.deepEqual(r1.results, [{ text: "1" }]);
  // The runtime under test is a live `wrangler dev` process, so the very
  // first execute() in a context takes the first snapshot synchronously
  // (canSnapshot() is true right after an ordinary top-level call) -- no
  // need to wait for anything async here.
  assert.equal(typeof r1.context.snapshotMs, "number");
  const after = await info("javascript", id);
  assert.equal(after.contexts.length, 1);
  const snap = after.contexts[0].snapshot;
  assert.ok(snap, "contexts[0].snapshot should be present after execute");
  assert.ok(snap.pages > 0);
  assert.ok(snap.bytes > 0);
  assert.equal(snap.stale, false);
  assert.equal(typeof snap.build, "string");
  assert.equal(typeof snap.takenAt, "number");
  // docs/snapshot-cost-design.md: storage is chunked in 1 MiB units, so the
  // on-disk footprint is a multiple of 1 MiB and at least as large as the
  // live (non-zero-page) byte count it's built from.
  const CHUNK_BYTES = 1024 * 1024;
  assert.equal(typeof snap.storedBytes, "number");
  assert.equal(snap.storedBytes % CHUNK_BYTES, 0);
  assert.ok(snap.storedBytes >= snap.bytes);

  await deleteContext("javascript", id, after.contexts[0].id);
  const afterDelete = await info("javascript", id);
  assert.deepEqual(afterDelete.contexts, []);
  console.log("javascript: GET / reports a context's snapshot after execute; deleting it clears the snapshot");
}

{
  const id = uniqueId("py-snapshot");
  const r1 = await execute("python", id, { code: "snapped = 1" });
  assert.equal(typeof r1.context.snapshotMs, "number");
  const after = await info("python", id);
  assert.ok(after.contexts[0].snapshot);
  assert.ok(after.contexts[0].snapshot.pages > 0);
  console.log("python: GET / reports a snapshot for the context after execute");
}

{
  const id = uniqueId("pl-snapshot");
  const r1 = await execute("perl", id, { code: "our $snapped = 1;" });
  assert.equal(typeof r1.context.snapshotMs, "number");
  const after = await info("perl", id);
  assert.ok(after.contexts[0].snapshot);
  assert.ok(after.contexts[0].snapshot.pages > 0);
  console.log("perl: GET / reports a snapshot for the context after execute");
}

// ---- limits (new ErrorResponse shape) --------------------------------------

{
  const id = uniqueId("js-limits");
  if (fileApi) {
    // The oversized content is generated INSIDE the guest (a tiny script over
    // the wire) rather than sent as request body content: the gateway caps
    // forwarded sandbox request bodies at the same size it uses for /execute
    // (MAX_REQUEST_BYTES, 96 KiB — well under the 1 MiB per-file workspace
    // limit this exercises), so a literal >1 MiB /files write can't reach the
    // runtime through the gateway at all.
    const big = await execute("javascript", id, {
      code:
        'let code; try { fs.writeFileSync("/workspace/big.txt", "x".repeat(1024*1024+1)); code = "none"; } catch (e) { code = e.code; } code',
    });
    assert.deepEqual(big.results, [{ text: "'EFBIG'" }]);

    const escape = await files("javascript", id, { op: "read", path: "../../etc/passwd" }, 403);
    assert.equal(escape.code, "PERMISSION_DENIED");
    assert.equal(escape.context.errno, "EACCES");
    const missing = await files("javascript", id, { op: "read", path: "/workspace/missing.txt" }, 404);
    assert.equal(missing.code, "FILE_NOT_FOUND");
    assert.equal(missing.context.errno, "ENOENT");
    // The gateway allows larger bodies on /files than on /execute, so an
    // over-limit write can reach the runtime and be rejected there.
    const tooLarge = await files(
      "javascript",
      id,
      { op: "write", path: "/workspace/toolarge.txt", content: "z".repeat(1024 * 1024 + 1) },
      413,
    );
    assert.equal(tooLarge.code, "FILE_TOO_LARGE");
    assert.equal(tooLarge.context.errno, "EFBIG");
    const large = await files("javascript", id, {
      op: "write",
      path: "/workspace/large.txt",
      content: "y".repeat(600 * 1024),
    });
    assert.equal(large.path, "/workspace/large.txt");
    console.log("javascript: file limits produce the ErrorResponse shape (code, context.errno)");
  } else {
    // With the File API disabled, guest fs writes are EACCES regardless of
    // size, and every /files op is 403 NOT_SUPPORTED regardless of path or
    // size -- the escape/missing/too-large distinctions this block otherwise
    // exercises don't apply.
    const big = await execute("javascript", id, {
      code:
        'let code; try { fs.writeFileSync("/workspace/big.txt", "x".repeat(1024*1024+1)); code = "none"; } catch (e) { code = e.code; } code',
    });
    assert.deepEqual(big.results, [{ text: "'EACCES'" }]);

    const escape = await files("javascript", id, { op: "read", path: "../../etc/passwd" }, 403);
    assert.equal(escape.code, "NOT_SUPPORTED");
    const missing = await files("javascript", id, { op: "read", path: "/workspace/missing.txt" }, 403);
    assert.equal(missing.code, "NOT_SUPPORTED");
    console.log(
      "javascript: with the File API disabled, guest fs writes are EACCES and every /files op is 403 NOT_SUPPORTED",
    );
  }
}

// ---- fuel exhaustion --------------------------------------------------

{
  const id = uniqueId("js-fuel");
  await execute("javascript", id, { code: "var survivor = 42" });
  const looped = await execute("javascript", id, { code: "while (true) {}" });
  assert.equal(looped.error.name, "ExecutionLimitError");
  const after = await execute("javascript", id, { code: "survivor" });
  assert.deepEqual(after.results, [{ text: "42" }]);
  console.log("javascript: fuel exhaustion in a context leaves it usable");
}

{
  const id = uniqueId("py-fuel");
  await execute("python", id, { code: "survivor = 42" });
  const looped = await execute("python", id, { code: "while True: pass" });
  assert.equal(looped.error.name, "ExecutionLimitError");
  // Python's instance is discarded and rebuilt from the persisted workspace;
  // in-memory globals not yet reflected in a snapshot are lost, but the
  // context itself keeps working.
  const after = await execute("python", id, { code: "1 + 1" });
  assert.deepEqual(after.results, [{ text: "2" }]);
  console.log("python: fuel exhaustion rebuilds the instance; context stays usable");
}

// ---- idle expiry ------------------------------------------------------

{
  const id = uniqueId("js-expiry");
  const before = Date.now();
  const r = await execute("javascript", id, { code: "1 + 1" });
  // The Playground's own engine/wrangler*.jsonc set a finite
  // SANDBOX_IDLE_TTL_MS, but a caller could disable expiry (`"0"`), in which
  // case expiresAt is omitted/null -- only assert the shape when present.
  if (r.context.expiresAt !== undefined) {
    assert.equal(typeof r.context.expiresAt, "number");
    assert.ok(r.context.expiresAt > before, "execute response context.expiresAt should be in the future");
  }
  const after = await info("javascript", id);
  assert.ok("expiresAt" in after, "GET / should include expiresAt");
  if (after.expiresAt !== null) {
    assert.equal(typeof after.expiresAt, "number");
    assert.ok(after.expiresAt > before, "GET / expiresAt should be in the future");
  }
  console.log("javascript: sandbox idle expiry (expiresAt) is present and in the future");
}

// ---- idle expiry throttling (docs/snapshot-cost-design.md decision 3) -----
//
// Re-arming the alarm and rewriting meta.sandbox.lastUsed only happen when
// the new deadline is more than TTL/10 later than the one actually armed;
// two executes moments apart are always well within TTL/10 for any TTL this
// deployment would plausibly use, so expiresAt must not move between them.

{
  const id = uniqueId("js-throttle-still");
  const r1 = await execute("javascript", id, { code: "1" });
  const r2 = await execute("javascript", id, { code: "2" });
  if (r1.context.expiresAt !== undefined && r2.context.expiresAt !== undefined) {
    assert.equal(
      r2.context.expiresAt,
      r1.context.expiresAt,
      "expiresAt should not move between two executes well within TTL/10 of each other",
    );
  }
  console.log("javascript: expiresAt does not move between two quick executes (throttled re-arm)");
}

// The "does move" half of decision 3 needs to wait past TTL/10, which is too
// slow to do against this deployment's real TTL (SANDBOX_IDLE_TTL_MS is
// 3600000 in engine/wrangler*.jsonc, so TTL/10 is 6 minutes). Run this case
// against a second dev server with a short TTL and point this file at it:
//
//   pnpm exec wrangler dev -c wrangler.jsonc -c engine/wrangler.jsonc \
//     -c engine/wrangler-python.jsonc -c engine/wrangler-perl.jsonc \
//     -c engine/wrangler-ruby.jsonc --var SANDBOX_IDLE_TTL_MS:20000 --port 8797
//   SANDBOX_URL=http://localhost:8797 TEST_IDLE_TTL_MS=20000 node tests/sandboxes.mjs
if (process.env.TEST_IDLE_TTL_MS) {
  const ttl = Number(process.env.TEST_IDLE_TTL_MS);
  const id = uniqueId("js-throttle-moves");
  const r1 = await execute("javascript", id, { code: "1" });
  assert.equal(typeof r1.context.expiresAt, "number");
  await new Promise((resolve) => setTimeout(resolve, ttl / 10 + 1000));
  const r2 = await execute("javascript", id, { code: "2" });
  assert.ok(
    r2.context.expiresAt > r1.context.expiresAt,
    `expiresAt should move after waiting past TTL/10 (${r1.context.expiresAt} -> ${r2.context.expiresAt})`,
  );
  checks++;
  console.log(`javascript: expiresAt moves after TTL/10 of inactivity (TEST_IDLE_TTL_MS=${ttl})`);
} else {
  console.log(
    "javascript: skipping the expiresAt-moves-after-TTL/10 check -- set TEST_IDLE_TTL_MS " +
      "(and point SANDBOX_URL at a dev server started with a matching --var SANDBOX_IDLE_TTL_MS) to run it",
  );
}

console.log(`${checks} sandbox HTTP checks passed against ${base}`);
