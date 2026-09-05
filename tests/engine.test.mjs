import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  runEngine,
  ExecutionLimitError,
} from "../packages/javascript/src/host.mjs";
import { transformForAsyncExecution } from "../packages/javascript/src/transform.mjs";
const module = new WebAssembly.Module(
  readFileSync(
    new URL("../packages/javascript/dist/engine.wasm", import.meta.url),
  ),
);
const run = (code, envVars) => runEngine(module, { code, envVars });

test("last top-level expression becomes the result", () => {
  assert.deepEqual(run("1 + 1;").results, [{ text: "2" }]);
  assert.deepEqual(run("[1, 2, 3]").results, [{ json: [1, 2, 3] }]);
  assert.deepEqual(run("({ a: 1 })").results, [{ json: { a: 1 } }]);
  assert.deepEqual(run("'hi'").results, [{ text: "'hi'" }]);
  assert.deepEqual(run("2n ** 64n").results, [
    { text: "18446744073709551616n" },
  ]);
  assert.deepEqual(run("undefined").results, []);
});

test("explicit return at top level still works", () => {
  assert.deepEqual(run("return 5;").results, [{ text: "5" }]);
});

test("actual Wasm supports async, BigInt, private fields and console", () => {
  const result = run(
    'class C { #x = 2; get() { return this.#x; } }; console.log("hello", process.env.NAME); await Promise.resolve({ n: new C().get(), big: 2n ** 64n });',
    { NAME: "world" },
  );
  assert.deepEqual(result.results, [
    { json: { n: 2, big: "18446744073709551616n" } },
  ]);
  assert.deepEqual(result.logs, { stdout: ["hello world"], stderr: [] });
  assert.ok(result.usage.fuelConsumed > 0);
});

test("process.env reflects envVars and host environment is not leaked", () => {
  assert.deepEqual(run("process.env.NAME", { NAME: "世界" }).results, [
    { text: "'世界'" },
  ]);
  assert.equal(run("process.env.HOME").results.length, 0);
});

test("console output is split into stdout and stderr", () => {
  const result = run(
    'console.log("a"); console.info("b"); console.debug("c"); console.warn("d"); console.error("e");',
  );
  assert.deepEqual(result.logs, { stdout: ["a", "b", "c"], stderr: ["d", "e"] });
});

test("a single trailing newline is stripped from each console entry", () => {
  const result = run('console.log("x\\n"); console.error("y\\n");');
  assert.deepEqual(result.logs, { stdout: ["x"], stderr: ["y"] });
});

test("guest syntax and runtime errors are structured", () => {
  const syntax = run("return (;");
  assert.equal(syntax.error.name, "SyntaxError");
  assert.deepEqual(syntax.results, []);
  const runtime = run('throw new TypeError("oops")');
  assert.equal(runtime.error.name, "TypeError");
  assert.equal(runtime.error.message, "oops");
  assert.ok(Array.isArray(runtime.error.traceback));
});

test("logs produced before an error are kept", () => {
  const result = run('console.log("before"); throw new Error("boom");');
  assert.deepEqual(result.logs.stdout, ["before"]);
  assert.equal(result.error.name, "Error");
});

test("fresh instance has no cross-request global state", () => {
  run("globalThis.secret = 42;");
  assert.equal(run("typeof secret").results[0].text, "'undefined'");
});

test("all shipped examples execute without error", () => {
  for (const name of [
    "hello",
    "modern-javascript",
    "data-transform",
    "web-apis",
  ]) {
    const result = run(
      readFileSync(new URL(`../examples/${name}.js`, import.meta.url), "utf8"),
      { NAME: "world", WORDS: "hello,world,hello" },
    );
    assert.equal(result.error, undefined, name);
  }
});

test("fuel interrupts unbounded JavaScript", () => {
  assert.throws(() => run("while (true) {}"), ExecutionLimitError);
});

test("fuel interrupts recursive execution and regex engine", () => {
  assert.ok(run("function f() { return f(); } f();").error);
  assert.throws(
    () => run('/^(a+)+$/.test("a".repeat(100)+"!");'),
    ExecutionLimitError,
  );
});

test("host network is denied", () => {
  assert.throws(
    () => run('await fetch("https://example.com")'),
    /Unsupported host capability/,
  );
});

test("console and result output are bounded", () => {
  const console_ = run("for(let i=0;i<201;i++) console.log(i)");
  assert.equal(console_.error.name, "ExecutionLimitError");
  const oversized = run('"a".repeat(140000)');
  assert.equal(oversized.error.name, "ExecutionLimitError");
});

test("linear memory maximum is enforced", () => {
  assert.ok(run("new Uint8Array(80 * 1024 * 1024).length").error);
});

test("transformForAsyncExecution rewrites the last expression into a return", () => {
  assert.equal(transformForAsyncExecution(""), "(async () => {})()");
  assert.equal(transformForAsyncExecution("   "), "(async () => {})()");
  assert.equal(
    transformForAsyncExecution("1 + 1"),
    "(async () => {\nreturn (1 + 1)\n})()",
  );
  assert.equal(
    transformForAsyncExecution("1 + 1;"),
    "(async () => {\nreturn (1 + 1)\n})()",
  );
  assert.equal(
    transformForAsyncExecution("console.log('x'); return 5;"),
    "(async () => {\nconsole.log('x'); return 5;\n})()",
  );
  assert.equal(
    transformForAsyncExecution("return (;"),
    "(async () => {\nreturn (;\n})()",
  );
});
