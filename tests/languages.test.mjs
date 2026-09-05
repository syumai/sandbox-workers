import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runEmbedded } from "../runtime/embedded.mjs";
import { runRuby } from "../runtime/ruby.mjs";
const cases = {
  python: {
    normal:
      'print("hello")\nreturn {"name": input["name"], "sum": sum(range(10))}',
    loop: "while True: pass",
    failure: 'raise ValueError("broken")',
    host: 'import os\nreturn os.environ.get("HOME")',
  },
  perl: {
    normal: 'print "hello"; return {name=>$input->{name},sum=>45};',
    loop: "while(1) {}",
    failure: 'die "broken";',
    host: "return $ENV{HOME};",
  },
  ruby: {
    normal: 'puts "hello"\nreturn {name: input["name"], sum: (0...10).sum}',
    loop: "loop {}",
    failure: 'raise "broken"',
    host: 'return ENV["HOME"]',
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
  const run = (code) =>
    language === "ruby"
      ? runRuby(module, { code, input: { name: "世界" } })
      : Promise.resolve().then(() =>
          runEmbedded(module, archive, language, {
            code,
            input: { name: "世界" },
          }),
        );
  test(`${language}: JSON, Unicode and stdout`, async () => {
    const r = await run(samples.normal);
    assert.deepEqual(r.result, { name: "世界", sum: 45 });
    assert.match(r.logs.map((x) => x.text).join(""), /hello/);
  });
  test(`${language}: error and fuel limit`, async () => {
    await assert.rejects(run(samples.failure), /broken/);
    await assert.rejects(run(samples.loop), /fuel exhausted/);
  });
  test(`${language}: host environment is not inherited`, async () => {
    assert.equal((await run(samples.host)).result, null);
  });
  if (language === "ruby")
    test("Ruby: JavaScript bridge is denied", async () => {
      await assert.rejects(
        run('require "js"; return JS.global[:process].to_s'),
        /disabled/,
      );
    });
}
for (const [language, files] of Object.entries({
  python: ["hello.py", "stdlib.py"],
  perl: ["hello.pl", "regex.pl"],
  ruby: ["hello.rb", "enumerable.rb"],
})) {
  test(`${language}: shipped examples`, async () => {
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
        input: {
          name: "world",
          words: ["hello", "world", "hello"],
          text: "Hello world! Hello Perl.",
        },
      };
      const result =
        language === "ruby"
          ? await runRuby(module, payload)
          : runEmbedded(module, archive, language, payload);
      assert.equal(result.ok, true);
    }
  });
}
