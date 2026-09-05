import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runJavaScript, ExecutionLimitError } from "../runtime/javascript.mjs";
import { transformForAsyncExecution } from "../packages/javascript/src/transform.mjs";
const module = new WebAssembly.Module(
  readFileSync(
    new URL("../packages/javascript/dist/engine.wasm", import.meta.url),
  ),
);
const run = (code, envVars) => runJavaScript(module, { code, envVars });

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

test("top-level return is rejected like the Cloudflare Sandbox SDK", () => {
  const result = run("return 1");
  assert.equal(result.error.name, "SyntaxError");
  assert.deepEqual(result.results, []);
});

test("return inside a nested function still works", () => {
  assert.equal(run("function f() { return 2 } f()").results[0].text, "2");
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
  assert.deepEqual(result.logs, {
    stdout: ["a", "b", "c"],
    stderr: ["d", "e"],
  });
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
    "intl",
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

test("recursion returns a catchable error, not a trap", () => {
  const result = run("function f() { return 1 + f(); } f();");
  assert.equal(result.error.name, "InternalError");
});

test("catastrophic regex backtracking is interrupted", () => {
  assert.throws(
    () => run('/^(a+)+$/.test("a".repeat(100) + "!");'),
    ExecutionLimitError,
  );
});

test("there is no fetch or other host network access", () => {
  const result = run('typeof fetch === "undefined" ? "gone" : "present";');
  assert.equal(result.results[0].text, "'gone'");
  assert.equal(
    run("await fetch('https://example.com')").error.name,
    "ReferenceError",
  );
});

test("console output is bounded to 200 entries / 32768 UTF-16 units", () => {
  const result = run("for (let i = 0; i < 201; i++) console.log(i);");
  assert.equal(result.error.name, "ExecutionLimitError");
});

test("serialized result is bounded to 64 KiB", () => {
  const result = run('"a".repeat(140000);');
  assert.equal(result.error.name, "ExecutionLimitError");
});

test("linear memory maximum is enforced", () => {
  const result = run("new Uint8Array(80 * 1024 * 1024).length;");
  assert.ok(result.error);
});

test("SharedArrayBuffer and Atomics are removed before guest code runs", () => {
  const result = run('typeof SharedArrayBuffer + "," + typeof Atomics;');
  assert.equal(result.results[0].text, "'undefined,undefined'");
});

test("Intl is available and backed by real locale data", () => {
  const result = run(
    'new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(1234);',
  );
  assert.match(result.results[0].text, /1,?234/);
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
    transformForAsyncExecution("return (;"),
    "(async () => {\nreturn (;\n})()",
  );
});

test("transformForAsyncExecution rejects a top-level return", () => {
  const illegalReturn =
    '(async () => { throw new SyntaxError("Illegal return statement"); })()';
  assert.equal(transformForAsyncExecution("return 1"), illegalReturn);
  assert.equal(
    transformForAsyncExecution("console.log('x'); return 5;"),
    illegalReturn,
  );
  assert.equal(
    transformForAsyncExecution("if (true) { return 1 }"),
    illegalReturn,
  );
  assert.equal(
    transformForAsyncExecution("for (;;) { return 1 }"),
    illegalReturn,
  );
  assert.equal(
    transformForAsyncExecution("try { return 1 } catch (e) {}"),
    illegalReturn,
  );
});

test("transformForAsyncExecution leaves nested returns alone", () => {
  assert.equal(
    transformForAsyncExecution("function f() { return 2 } f()"),
    "(async () => {\nfunction f() { return 2 } return (f())\n})()",
  );
  assert.equal(
    transformForAsyncExecution("(() => { return 3 })()"),
    "(async () => {\nreturn ((() => { return 3 })())\n})()",
  );
});
