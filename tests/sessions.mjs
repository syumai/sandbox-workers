// HTTP tests for durable sessions, run like tests/http.mjs against a running
// gateway (SANDBOX_URL). The gateway forwards
// /languages/:language/sessions/:id/... to the runtime binding for
// :language as /sessions/:id/... (see src/index.ts).
import assert from "node:assert/strict";

const base = process.env.SANDBOX_URL ?? "http://localhost:8787";
let checks = 0;

function sessionUrl(language, id, subpath = "") {
  return `${base}/languages/${language}/sessions/${id}${subpath}`;
}

async function execute(language, id, body, status = 200) {
  const res = await fetch(sessionUrl(language, id, "/execute"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, status, `execute ${language}/${id}: unexpected status`);
  checks++;
  return res.json();
}

async function files(language, id, body, status = 200) {
  const res = await fetch(sessionUrl(language, id, "/files"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, status, `files ${language}/${id}: unexpected status`);
  checks++;
  return res.json();
}

async function info(language, id) {
  const res = await fetch(sessionUrl(language, id));
  assert.equal(res.status, 200);
  checks++;
  return res.json();
}

async function reset(language, id) {
  const res = await fetch(sessionUrl(language, id, "/reset"), { method: "POST" });
  assert.equal(res.status, 200);
  checks++;
  return res.json();
}

async function destroy(language, id) {
  const res = await fetch(sessionUrl(language, id), { method: "DELETE" });
  assert.equal(res.status, 200);
  checks++;
  return res.json();
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- JavaScript ------------------------------------------------------

{
  const id = uniqueId("js-basic");
  const r1 = await execute("javascript", id, { code: "var counter = 1; counter" });
  assert.deepEqual(r1.results, [{ text: "1" }]);
  assert.equal(r1.session.id, id);
  assert.equal(r1.session.executions, 1);
  const r2 = await execute("javascript", id, { code: "counter += 1; counter" });
  assert.deepEqual(r2.results, [{ text: "2" }]);
  assert.equal(r2.session.executions, 2);
  console.log("javascript: variable persists across calls");
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
}

{
  const id = uniqueId("js-cwd");
  await execute("javascript", id, { code: 'fs.mkdirSync("/workspace/sub"); process.chdir("sub")' });
  const r = await execute("javascript", id, { code: "process.cwd()" });
  assert.deepEqual(r.results, [{ text: "'/workspace/sub'" }]);
  assert.equal(r.session.cwd, "/workspace/sub");
  console.log("javascript: cwd persists after process.chdir");
}

{
  const id = uniqueId("js-import");
  await execute("javascript", id, {
    code: 'fs.writeFileSync("/workspace/lib.mjs", "export const val = 99;")',
  });
  const r = await execute("javascript", id, { code: 'const m = await import("./lib.mjs"); m.val' });
  assert.deepEqual(r.results, [{ text: "99" }]);
  console.log('javascript: import("./lib.mjs") is served from the workspace');
}

// ---- Python ------------------------------------------------------------

{
  const id = uniqueId("py-basic");
  await execute("python", id, { code: "counter = 1" });
  const r = await execute("python", id, { code: "counter + 1" });
  assert.deepEqual(r.results, [{ text: "2" }]);
  console.log("python: variable persists across calls");
}

{
  const id = uniqueId("py-fs");
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
}

{
  const id = uniqueId("py-cwd");
  await execute("python", id, { code: 'import os\nos.mkdir("/workspace/sub")\nos.chdir("sub")' });
  const r = await execute("python", id, { code: "import os\nos.getcwd()" });
  assert.deepEqual(r.results, [{ text: "'/workspace/sub'" }]);
  assert.equal(r.session.cwd, "/workspace/sub");
  console.log("python: cwd persists after os.chdir");
}

{
  const id = uniqueId("py-import");
  await execute("python", id, {
    code: 'open("/workspace/lib.py", "w").write("val = 99\\n")',
  });
  const r = await execute("python", id, { code: "import lib\nlib.val" });
  assert.deepEqual(r.results, [{ text: "99" }]);
  console.log("python: import lib from /workspace");
}

// ---- Perl ----------------------------------------------------------------

{
  const id = uniqueId("pl-basic");
  await execute("perl", id, { code: "our $counter = 1;" });
  const r = await execute("perl", id, { code: "$counter + 1;" });
  assert.deepEqual(r.results, [{ text: "2" }]);
  console.log("perl: our variable persists across calls");
}

{
  const id = uniqueId("pl-fs");
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
}

{
  const id = uniqueId("pl-cwd");
  await execute("perl", id, { code: 'mkdir("/workspace/sub"); chdir("sub") or die $!; 1;' });
  const r = await execute("perl", id, { code: "1;" });
  assert.equal(r.session.cwd, "/workspace/sub");
  console.log("perl: cwd persists after chdir");
}

// ---- Ruby: sessions unsupported -------------------------------------------

{
  const id = uniqueId("rb");
  const res = await fetch(sessionUrl("ruby", id, "/execute"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "1" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /not supported for ruby/);
  checks++;
  console.log("ruby: sessions return 400");
}

// ---- reset / delete --------------------------------------------------

{
  const id = uniqueId("js-reset");
  await execute("javascript", id, { code: "var kept = 1" });
  await files("javascript", id, { op: "write", path: "/workspace/keep.txt", content: "still here" });
  await reset("javascript", id);
  const r = await execute("javascript", id, {
    code: 'typeof kept === "undefined" ? "cleared" : "kept"',
  });
  assert.deepEqual(r.results, [{ text: "'cleared'" }]);
  const stillThere = await files("javascript", id, { op: "read", path: "/workspace/keep.txt" });
  assert.equal(stillThere.content, "still here");
  console.log("javascript: reset clears globals but keeps files");
}

{
  const id = uniqueId("js-delete");
  await execute("javascript", id, { code: "1" });
  await files("javascript", id, { op: "write", path: "/workspace/gone.txt", content: "x" });
  await destroy("javascript", id);
  const afterInfo = await info("javascript", id);
  // A fresh GET after DELETE creates a brand-new session record.
  assert.equal(afterInfo.executions, 0);
  const gone = await files("javascript", id, { op: "exists", path: "/workspace/gone.txt" });
  assert.equal(gone.exists, false);
  console.log("javascript: DELETE removes everything");
}

// ---- memory snapshots (phase 2) ---------------------------------------

{
  const id = uniqueId("js-snapshot");
  const before = await info("javascript", id);
  assert.equal(before.snapshot, null);
  const r1 = await execute("javascript", id, { code: "var snapped = 1; snapped" });
  assert.deepEqual(r1.results, [{ text: "1" }]);
  // The runtime under test is a live `wrangler dev` process, so the very
  // first execute() in a session takes the first snapshot synchronously
  // (canSnapshot() is true right after an ordinary top-level call) -- no
  // need to wait for anything async here.
  assert.equal(typeof r1.session.snapshotMs, "number");
  const after = await info("javascript", id);
  assert.ok(after.snapshot, "GET info should report a snapshot after an execute");
  assert.ok(after.snapshot.pages > 0);
  assert.ok(after.snapshot.bytes > 0);
  assert.equal(after.snapshot.stale, false);
  assert.equal(typeof after.snapshot.build, "string");
  assert.equal(typeof after.snapshot.takenAt, "number");

  await reset("javascript", id);
  const afterReset = await info("javascript", id);
  assert.equal(afterReset.snapshot, null);
  console.log("javascript: GET info reports a snapshot after execute; reset clears it");
}

{
  const id = uniqueId("py-snapshot");
  const r1 = await execute("python", id, { code: "snapped = 1" });
  assert.equal(typeof r1.session.snapshotMs, "number");
  const after = await info("python", id);
  assert.ok(after.snapshot);
  assert.ok(after.snapshot.pages > 0);
  console.log("python: GET info reports a snapshot after execute");
}

{
  const id = uniqueId("pl-snapshot");
  const r1 = await execute("perl", id, { code: "our $snapped = 1;" });
  assert.equal(typeof r1.session.snapshotMs, "number");
  const after = await info("perl", id);
  assert.ok(after.snapshot);
  assert.ok(after.snapshot.pages > 0);
  console.log("perl: GET info reports a snapshot after execute");
}

// ---- limits -----------------------------------------------------------

{
  const id = uniqueId("js-limits");
  // The oversized content is generated INSIDE the guest (a tiny script over
  // the wire) rather than sent as request body content: the gateway caps
  // forwarded session request bodies at the same size it uses for /execute
  // (MAX_REQUEST_BYTES, 96 KiB — well under the 1 MiB per-file workspace
  // limit this exercises), so a literal >1 MiB /files write can't reach the
  // runtime through the gateway at all.
  const big = await execute("javascript", id, {
    code:
      'let code; try { fs.writeFileSync("/workspace/big.txt", "x".repeat(1024*1024+1)); code = "none"; } catch (e) { code = e.code; } code',
  });
  assert.deepEqual(big.results, [{ text: "'EFBIG'" }]);

  const escape = await files("javascript", id, { op: "read", path: "../../etc/passwd" }, 403);
  assert.equal(escape.error.name, "FileError");
  assert.equal(escape.error.code, "EACCES");
  const missing = await files("javascript", id, { op: "read", path: "/workspace/missing.txt" }, 404);
  assert.equal(missing.error.name, "FileError");
  assert.equal(missing.error.code, "ENOENT");
  // The gateway allows larger bodies on /files than on /execute, so an
  // over-limit write can reach the runtime and be rejected there.
  const tooLarge = await files(
    "javascript",
    id,
    { op: "write", path: "/workspace/toolarge.txt", content: "z".repeat(1024 * 1024 + 1) },
    413,
  );
  assert.equal(tooLarge.error.code, "EFBIG");
  const large = await files("javascript", id, {
    op: "write",
    path: "/workspace/large.txt",
    content: "y".repeat(600 * 1024),
  });
  assert.equal(large.size, 600 * 1024);
  console.log("javascript: file limits produce the right error codes");
}

// ---- fuel exhaustion --------------------------------------------------

{
  const id = uniqueId("js-fuel");
  await execute("javascript", id, { code: "var survivor = 42" });
  const looped = await execute("javascript", id, { code: "while (true) {}" });
  assert.equal(looped.error.name, "ExecutionLimitError");
  const after = await execute("javascript", id, { code: "survivor" });
  assert.deepEqual(after.results, [{ text: "42" }]);
  console.log("javascript: fuel exhaustion in a session leaves it usable");
}

{
  const id = uniqueId("py-fuel");
  await execute("python", id, { code: "survivor = 42" });
  const looped = await execute("python", id, { code: "while True: pass" });
  assert.equal(looped.error.name, "ExecutionLimitError");
  // Python's instance is discarded and rebuilt from the persisted workspace;
  // in-memory globals (no snapshot yet in phase 1) are lost, but the session
  // itself keeps working.
  const after = await execute("python", id, { code: "1 + 1" });
  assert.deepEqual(after.results, [{ text: "2" }]);
  console.log("python: fuel exhaustion rebuilds the instance; session stays usable");
}

console.log(`${checks} session HTTP checks passed against ${base}`);
