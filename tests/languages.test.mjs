import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runEmbedded, createEmbeddedSession } from "../runtime/embedded.mjs";
import { runRuby } from "../runtime/ruby.mjs";
import { Workspace } from "../runtime/workspace.mjs";
const cases = {
  python: {
    normal:
      'import os\nprint("hello")\n{"name": os.environ["NAME"], "sum": sum(range(10))}',
    loop: "while True: pass",
    failure: 'raise ValueError("broken")',
    host: 'import os\nos.environ.get("HOME")',
    logs: 'print("a")\nprint("b")',
  },
  perl: {
    normal: 'print "hello"; +{ name => $ENV{NAME}, sum => 45 };',
    loop: "while(1) {}",
    failure: 'die "broken";',
    host: "$ENV{HOME};",
    logs: 'print "a\\n"; print "b\\n";',
  },
  ruby: {
    normal: 'puts "hello"\n{name: ENV["NAME"], sum: (0...10).sum}',
    loop: "loop {}",
    failure: 'raise "broken"',
    host: 'ENV["HOME"]',
    logs: 'puts "a"\nputs "b"',
  },
};
for (const [language, samples] of Object.entries(cases)) {
  const module = new WebAssembly.Module(
    readFileSync(`packages/${language}/dist/engine.wasm`),
  );
  const archive =
    language === "ruby"
      ? null
      : readFileSync(`packages/${language}/dist/stdlib.bin`);
  const run = (code, envVars = { NAME: "世界" }) =>
    language === "ruby"
      ? runRuby(module, { code, envVars })
      : Promise.resolve().then(() =>
          runEmbedded(module, archive, language, { code, envVars }),
        );
  test(`${language}: last expression, envVars and stdout`, async () => {
    const r = await run(samples.normal);
    assert.deepEqual(r.results, [{ json: { name: "世界", sum: 45 } }]);
    assert.match(r.logs.stdout.join(""), /hello/);
    assert.deepEqual(r.logs.stderr, []);
    assert.equal(r.error, undefined);
  });
  if (samples.explicitReturn)
    test(`${language}: explicit top-level return still works`, async () => {
      const r = await run(samples.explicitReturn);
      assert.deepEqual(r.results, [{ json: { name: "世界", sum: 45 } }]);
    });
  test(`${language}: error envelope has a name and message`, async () => {
    const r = await run(samples.failure);
    assert.ok(r.error.name);
    assert.match(r.error.message, /broken/);
    assert.deepEqual(r.results, []);
  });
  test(`${language}: fuel exhaustion is thrown as ExecutionLimitError`, async () => {
    await assert.rejects(run(samples.loop), /fuel exhausted/);
  });
  test(`${language}: host environment is not inherited`, async () => {
    const r = await run(samples.host, {});
    assert.deepEqual(r.results, []);
  });
  test(`${language}: log entries are one line each, without trailing newlines`, async () => {
    const r = await run(samples.logs, {});
    assert.deepEqual(r.logs.stdout, ["a", "b"]);
    assert.deepEqual(r.logs.stderr, []);
  });
  if (language === "ruby") {
    test("Ruby: JavaScript bridge is denied", async () => {
      await assert.rejects(
        run('require "js"; JS.global[:process].to_s'),
        /disabled/,
      );
    });
    test("Ruby: a syntax error is reported in error, with logs preserved", async () => {
      const r = await run('puts "before"\n1 +');
      assert.equal(r.error.name, "SyntaxError");
      assert.deepEqual(r.results, []);
      // A genuine syntax error fails to compile before anything runs, so
      // there is nothing to print here — this asserts the accumulated log
      // buffer (empty in this case) is still returned rather than dropped.
      assert.deepEqual(r.logs.stdout, []);
    });
    test("Ruby: logs printed before a runtime error are preserved", async () => {
      const r = await run('puts "before"\nraise "boom"');
      assert.equal(r.error.name, "RuntimeError");
      assert.deepEqual(r.logs.stdout, ["before"]);
      assert.deepEqual(r.results, []);
    });
    test("Ruby: top-level return is reported in error, not thrown", async () => {
      const r = await run('puts "before"\nreturn 1');
      assert.equal(r.error.name, "LocalJumpError");
      assert.deepEqual(r.logs.stdout, ["before"]);
      assert.deepEqual(r.results, []);
      // the engine keeps working for the next call
      const next = await run("1 + 1");
      assert.deepEqual(next.results, [{ text: "2" }]);
    });
  }
  if (language === "perl")
    test("Perl: unicode env values and literals print without warnings or double encoding", async () => {
      const r = await run(
        'print "$ENV{NAME}\\n"; print "こんにちは\\n"; +{ name => $ENV{NAME} };',
      );
      assert.deepEqual(r.logs.stdout, ["世界", "こんにちは"]);
      assert.deepEqual(r.logs.stderr, []);
      assert.deepEqual(r.results, [{ json: { name: "世界" } }]);
    });
}
// ---- createEmbeddedSession (durable sessions, phase 1: Python & Perl) ----

for (const language of ["python", "perl"]) {
  const module = new WebAssembly.Module(readFileSync(`packages/${language}/dist/engine.wasm`));
  const archive = readFileSync(`packages/${language}/dist/stdlib.bin`);
  const varDef = language === "python" ? "counter = 1" : "our $counter = 1; 1;";
  const varUse = language === "python" ? "counter + 1" : "$counter + 1";
  const writeCode =
    language === "python"
      ? 'open("/workspace/a.txt", "w").write("hi")'
      : 'open(my $fh, ">", "/workspace/a.txt") or die $!; print $fh "hi"; close($fh); 1;';
  const readCode = language === "python" ? 'open("/workspace/a.txt").read()' : undefined;
  const chdirCode =
    language === "python"
      ? 'import os\nos.mkdir("/workspace/sub")\nos.chdir("sub")\nos.getcwd()'
      : 'mkdir("/workspace/sub"); chdir("sub") or die $!; 1;';
  const loopCode = language === "python" ? "while True: pass" : "while(1) {}";

  test(`${language} session: a variable defined in call 1 is visible in call 2`, () => {
    const workspace = new Workspace();
    const session = createEmbeddedSession(module, archive, language, { workspace, cwd: "/workspace" });
    session.execute({ code: varDef });
    const r = session.execute({ code: varUse });
    assert.deepEqual(r.results, [{ text: "2" }]);
  });

  test(`${language} session: files written by the guest are readable via the shared workspace`, () => {
    const workspace = new Workspace();
    const session = createEmbeddedSession(module, archive, language, { workspace, cwd: "/workspace" });
    session.execute({ code: writeCode });
    assert.equal(workspace.read("/workspace/a.txt", "/workspace").content, "hi");
    if (readCode) {
      workspace.write("/workspace/b.txt", "/workspace", "from host");
      const r = session.execute({ code: 'open("/workspace/b.txt").read()' });
      assert.deepEqual(r.results, [{ text: "'from host'" }]);
    }
  });

  test(`${language} session: cwd persists across calls after chdir`, () => {
    const workspace = new Workspace();
    const session = createEmbeddedSession(module, archive, language, { workspace, cwd: "/workspace" });
    session.execute({ code: chdirCode });
    assert.equal(session.cwd, "/workspace/sub");
  });

  test(`${language} session: fuel exhaustion invalidates the instance (caller must rebuild)`, () => {
    const workspace = new Workspace();
    const session = createEmbeddedSession(module, archive, language, { workspace, cwd: "/workspace" });
    session.execute({ code: varDef });
    const r = session.execute({ code: loopCode });
    assert.equal(r.error.name, "ExecutionLimitError");
    assert.equal(session.invalid, true);
  });

  test(`${language} session: an ordinary guest exception does not invalidate the instance`, () => {
    const workspace = new Workspace();
    const session = createEmbeddedSession(module, archive, language, { workspace, cwd: "/workspace" });
    session.execute({ code: varDef });
    const failCode = language === "python" ? 'raise ValueError("boom")' : 'die "boom";';
    const r = session.execute({ code: failCode });
    assert.ok(r.error);
    assert.equal(session.invalid, false);
    const after = session.execute({ code: varUse });
    assert.deepEqual(after.results, [{ text: "2" }]);
  });
}

// ---- workspace.disabled: guest /workspace lockout (runtime/wasi.mjs) -----

test("python session: workspace.disabled gates open()/os.* with PermissionError", () => {
  const module = new WebAssembly.Module(readFileSync("packages/python/dist/engine.wasm"));
  const archive = readFileSync("packages/python/dist/stdlib.bin");
  const workspace = new Workspace();
  const session = createEmbeddedSession(module, archive, "python", { workspace, cwd: "/workspace" });
  workspace.disabled = true;

  const write = session.execute({
    code:
      "try:\n    open('/workspace/a.txt', 'w')\n    r = 'ok'\nexcept Exception as e:\n    r = type(e).__name__\nr",
  });
  assert.deepEqual(write.results, [{ text: "'PermissionError'" }]);

  const read = session.execute({
    code:
      "try:\n    open('/workspace/a.txt')\n    r = 'ok'\nexcept Exception as e:\n    r = type(e).__name__\nr",
  });
  assert.deepEqual(read.results, [{ text: "'PermissionError'" }]);

  const mkdir = session.execute({
    code:
      "import os\ntry:\n    os.mkdir('/workspace/d')\n    r = 'ok'\nexcept Exception as e:\n    r = type(e).__name__\nr",
  });
  assert.deepEqual(mkdir.results, [{ text: "'PermissionError'" }]);

  const listdir = session.execute({
    code:
      "try:\n    os.listdir('/workspace')\n    r = 'ok'\nexcept Exception as e:\n    r = type(e).__name__\nr",
  });
  assert.deepEqual(listdir.results, [{ text: "'PermissionError'" }]);

  const cwd = session.execute({ code: "os.getcwd()" });
  assert.deepEqual(cwd.results, [{ text: "'/workspace'" }]);

  const json = session.execute({ code: "import json\njson.dumps([1])" });
  assert.deepEqual(json.results, [{ text: "'[1]'" }]);
  assert.equal(json.error, undefined);

  assert.equal(session.canSnapshot(), true);
});

test("python session: workspace.disabled is read live, not captured at session boot", () => {
  const module = new WebAssembly.Module(readFileSync("packages/python/dist/engine.wasm"));
  const archive = readFileSync("packages/python/dist/stdlib.bin");
  const workspace = new Workspace();
  const session = createEmbeddedSession(module, archive, "python", { workspace, cwd: "/workspace" });
  workspace.disabled = true;

  const denied = session.execute({
    code:
      "try:\n    open('/workspace/a.txt', 'w')\n    r = 'ok'\nexcept Exception as e:\n    r = type(e).__name__\nr",
  });
  assert.deepEqual(denied.results, [{ text: "'PermissionError'" }]);

  workspace.disabled = false;
  const allowed = session.execute({
    code: "open('/workspace/a.txt', 'w').write('y')\nopen('/workspace/a.txt').read()",
  });
  assert.deepEqual(allowed.results, [{ text: "'y'" }]);
  assert.equal(allowed.error, undefined);
});

test("perl session: workspace.disabled gates open() with Permission denied", () => {
  const module = new WebAssembly.Module(readFileSync("packages/perl/dist/engine.wasm"));
  const archive = readFileSync("packages/perl/dist/stdlib.bin");
  const workspace = new Workspace();
  const session = createEmbeddedSession(module, archive, "perl", { workspace, cwd: "/workspace" });
  workspace.disabled = true;

  const write = session.execute({
    code: `open(my $fh, '>', '/workspace/a.txt') ? 'ok' : "$!";`,
  });
  assert.equal(write.results.length, 1);
  assert.match(write.results[0].text, /Permission denied/);

  const read = session.execute({
    code: `open(my $fh, '<', '/workspace/a.txt') ? 'ok' : "$!";`,
  });
  assert.equal(read.results.length, 1);
  assert.match(read.results[0].text, /Permission denied/);

  const cwd = session.execute({ code: "use Cwd; getcwd();" });
  assert.deepEqual(cwd.results, [{ text: "/workspace" }]);

  assert.equal(session.canSnapshot(), true);
});

test("perl session: workspace.disabled is read live, not captured at session boot", () => {
  const module = new WebAssembly.Module(readFileSync("packages/perl/dist/engine.wasm"));
  const archive = readFileSync("packages/perl/dist/stdlib.bin");
  const workspace = new Workspace();
  const session = createEmbeddedSession(module, archive, "perl", { workspace, cwd: "/workspace" });
  workspace.disabled = true;

  const denied = session.execute({
    code: `open(my $fh, '>', '/workspace/a.txt') ? 'ok' : "$!";`,
  });
  assert.match(denied.results[0].text, /Permission denied/);

  workspace.disabled = false;
  const allowed = session.execute({
    code: `open(my $fh, '>', '/workspace/a.txt') ? 'ok' : "$!";`,
  });
  assert.deepEqual(allowed.results, [{ text: "ok" }]);
  assert.equal(allowed.error, undefined);
});

test("python session: `import lib` resolves modules from /workspace", () => {
  const module = new WebAssembly.Module(readFileSync("packages/python/dist/engine.wasm"));
  const archive = readFileSync("packages/python/dist/stdlib.bin");
  const workspace = new Workspace();
  const session = createEmbeddedSession(module, archive, "python", { workspace, cwd: "/workspace" });
  session.execute({ code: 'open("/workspace/lib.py", "w").write("val = 7\\n")' });
  const r = session.execute({ code: "import lib\nlib.val" });
  assert.deepEqual(r.results, [{ text: "7" }]);
});

for (const [language, files] of Object.entries({
  python: ["hello.py", "stdlib.py"],
  perl: ["hello.pl", "regex.pl"],
  ruby: ["hello.rb", "enumerable.rb"],
})) {
  test(`${language}: shipped examples run without error`, async () => {
    const module = new WebAssembly.Module(
      readFileSync(`packages/${language}/dist/engine.wasm`),
    );
    const archive =
      language === "ruby"
        ? null
        : readFileSync(`packages/${language}/dist/stdlib.bin`);
    for (const file of files) {
      const payload = {
        code: readFileSync(`examples/${language}/${file}`, "utf8"),
        envVars: { NAME: "world", WORDS: "hello,world,hello" },
      };
      const result =
        language === "ruby"
          ? await runRuby(module, payload)
          : runEmbedded(module, archive, language, payload);
      assert.equal(result.error, undefined, file);
    }
  });
}
