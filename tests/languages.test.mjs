import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runEmbedded } from "../runtime/embedded.mjs";
import { runRuby } from "../runtime/ruby.mjs";
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
    explicitReturn: 'print "hello"; return { name => $ENV{NAME}, sum => 45 };',
    loop: "while(1) {}",
    failure: 'die "broken";',
    host: "$ENV{HOME};",
    logs: 'print "a\\n"; print "b\\n";',
  },
  ruby: {
    normal: 'puts "hello"\n{name: ENV["NAME"], sum: (0...10).sum}',
    explicitReturn: 'return {name: ENV["NAME"], sum: (0...10).sum}',
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
  if (language === "ruby")
    test("Ruby: JavaScript bridge is denied", async () => {
      await assert.rejects(
        run('require "js"; JS.global[:process].to_s'),
        /disabled/,
      );
    });
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
