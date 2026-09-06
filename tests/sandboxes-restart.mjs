// End-to-end acceptance test for phase 2 (memory snapshots): a sandbox must
// survive a Durable Object eviction across a full `wrangler dev` process
// restart, not just quick in-memory reuse. Unlike tests/sandboxes.mjs (which
// runs entirely against one `wrangler dev` process and never exercises a
// restore from storage), this file is meant to be run TWICE against two
// separate `wrangler dev` processes that share the same --persist-to state:
//
//   PHASE=1 node tests/sandboxes-restart.mjs   # while wrangler dev #1 is up
//   <stop wrangler dev #1>
//   <start wrangler dev #2, same --persist-to>
//   PHASE=2 node tests/sandboxes-restart.mjs   # while wrangler dev #2 is up
//
// PHASE=1 defines a variable, a function, and (for JavaScript and Python) a
// class in one sandbox's default context per language, and writes a file.
// PHASE=2 -- run against a brand-new wrangler dev process, so every Sandbox
// Durable Object instance's in-memory interpreter is gone -- checks that the
// variable, the function, a class method call, and the file are all still
// there, restored from the snapshot taken during PHASE=1.
import assert from "node:assert/strict";

const base = process.env.SANDBOX_URL ?? "http://localhost:8791";
const phase = process.env.PHASE ?? "1";
if (phase !== "1" && phase !== "2") throw new Error("PHASE must be 1 or 2");

// Fixed (not time-random) ids: phase 2 must address the exact same sandboxes
// phase 1 created.
const ids = { javascript: "restart-js", python: "restart-py", perl: "restart-pl" };

function sandboxUrl(language, id, subpath = "") {
  return `${base}/languages/${language}/sandboxes/${id}${subpath}`;
}

// Both phases address the *default* context: executing without a
// `contextId` (see docs/sdk-parity-design.md, "Default context").
async function execute(language, id, body) {
  const res = await fetch(sandboxUrl(language, id, "/execute"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `execute ${language}/${id}: unexpected status`);
  return res.json();
}

async function readFile(language, id, path) {
  const res = await fetch(sandboxUrl(language, id, "/files"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "read", path }),
  });
  assert.equal(res.status, 200, `read ${language}/${id}${path}: unexpected status`);
  return res.json();
}

async function info(language, id) {
  const res = await fetch(sandboxUrl(language, id));
  assert.equal(res.status, 200);
  return res.json();
}

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`  ok - ${message}`);
}

if (phase === "1") {
  console.log(`PHASE 1: defining state in sandboxes ${JSON.stringify(ids)} against ${base}`);

  const js = await execute("javascript", ids.javascript, {
    code:
      "var counter = 41; function inc(n) { return n + 1; } " +
      "class Greeter { hello(name) { return 'hello ' + name; } } " +
      "fs.writeFileSync('/workspace/marker.txt', 'phase1'); 'defined'",
  });
  check(js.results?.[0]?.text === "'defined'", "javascript: definitions + file write executed");
  check(typeof js.context.snapshotMs === "number", "javascript: execute() reports context.snapshotMs");

  const py = await execute("python", ids.python, {
    code:
      "class Box:\n    def __init__(self, v):\n        self.v = v\n    def get(self):\n        return self.v\n" +
      "counter = 41\ndef inc(n):\n    return n + 1\nb = Box(9)\n" +
      "open('/workspace/marker.txt', 'w').write('phase1')\n'defined'",
  });
  check(py.results?.[0]?.text === "'defined'", "python: definitions + file write executed");
  check(typeof py.context.snapshotMs === "number", "python: execute() reports context.snapshotMs");

  const pl = await execute("perl", ids.perl, {
    code:
      "our $counter = 41; sub inc { return $_[0] + 1; } " +
      "open(my $fh, '>', '/workspace/marker.txt') or die $!; print $fh 'phase1'; close($fh); " +
      "'defined';",
  });
  check(pl.results?.[0]?.text === "defined", "perl: definitions + file write executed");
  check(typeof pl.context.snapshotMs === "number", "perl: execute() reports context.snapshotMs");

  for (const [language, id] of Object.entries(ids)) {
    const snapshotInfo = await info(language, id);
    const snapshot = snapshotInfo.contexts?.[0]?.snapshot;
    check(!!snapshot && snapshot.pages > 0, `${language}: GET info reports a snapshot before restart`);
  }

  console.log(`PHASE 1 complete: ${checks} checks passed. Stop wrangler dev, start a new instance, then run PHASE=2.`);
} else {
  console.log(`PHASE 2: verifying state survived a wrangler dev restart in sandboxes ${JSON.stringify(ids)} against ${base}`);

  const js = await execute("javascript", ids.javascript, {
    code: "counter + '/' + inc(1) + '/' + new Greeter().hello('world')",
  });
  check(!js.error, `javascript: execution after restart did not error (${js.error ? JSON.stringify(js.error) : ""})`);
  check(
    JSON.stringify(js.results) === JSON.stringify([{ text: "'41/2/hello world'" }]),
    `javascript: variable, function, and a class method call all survived the restart (got ${JSON.stringify(js.results)})`,
  );

  const py = await execute("python", ids.python, {
    code: "str(counter) + '/' + str(inc(1)) + '/' + str(b.get())",
  });
  check(!py.error, `python: execution after restart did not error (${py.error ? JSON.stringify(py.error) : ""})`);
  check(
    JSON.stringify(py.results) === JSON.stringify([{ text: "'41/2/9'" }]),
    `python: variable, function, and a class method call all survived the restart (got ${JSON.stringify(py.results)})`,
  );

  const pl = await execute("perl", ids.perl, { code: "$counter . '/' . inc(1);" });
  check(!pl.error, `perl: execution after restart did not error (${pl.error ? JSON.stringify(pl.error) : ""})`);
  check(
    JSON.stringify(pl.results) === JSON.stringify([{ text: "41/2" }]),
    `perl: our variable and a sub survived the restart (got ${JSON.stringify(pl.results)})`,
  );

  for (const [language, id] of Object.entries(ids)) {
    const file = await readFile(language, id, "/workspace/marker.txt");
    check(file.content === "phase1", `${language}: /workspace/marker.txt survived the restart`);
  }

  console.log(`PHASE 2 complete: ${checks} checks passed. Durable sandboxes survived a full wrangler dev restart.`);
}
