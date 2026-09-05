import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  runEngine,
  ExecutionLimitError,
} from "../packages/javascript/src/host.mjs";
const module = new WebAssembly.Module(
  readFileSync(
    new URL("../packages/javascript/dist/engine.wasm", import.meta.url),
  ),
);
const run = (code, input) => runEngine(module, { code, input });
test("actual Wasm supports async, BigInt, private fields and console", () => {
  const result = run(
    'class C { #x = 2; get() { return this.#x; } }; console.log("hello", input); return await Promise.resolve({ n: new C().get(), big: 2n ** 64n });',
    42,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { n: 2, big: "18446744073709551616n" });
  assert.deepEqual(result.logs, [{ level: "log", text: "hello 42" }]);
  assert.ok(result.usage.fuelConsumed > 0);
});
test("guest syntax and runtime errors are structured", () => {
  assert.equal(run("return (;").error.name, "SyntaxError");
  assert.equal(run('throw new TypeError("oops")').error.message, "oops");
});
test("fresh instance has no cross-request global state", () => {
  run("globalThis.secret = 42;");
  assert.equal(run("return typeof secret").result, "undefined");
});
test("all shipped examples execute", () => {
  for (const name of [
    "hello",
    "modern-javascript",
    "data-transform",
    "web-apis",
  ])
    assert.equal(
      run(
        readFileSync(
          new URL(`../examples/${name}.js`, import.meta.url),
          "utf8",
        ),
      ).ok,
      true,
      name,
    );
});
test("fuel interrupts unbounded JavaScript", () => {
  assert.throws(() => run("while (true) {}"), ExecutionLimitError);
});
test("fuel interrupts recursive execution and regex engine", () => {
  assert.equal(run("function f() { return f(); } f();").ok, false);
  assert.throws(
    () => run('return /^(a+)+$/.test("a".repeat(100)+"!");'),
    ExecutionLimitError,
  );
});
test("host network is denied", () => {
  assert.throws(
    () => run('return await fetch("https://example.com")'),
    /Unsupported host capability/,
  );
});
test("console and result output are bounded", () => {
  assert.equal(run("for(let i=0;i<201;i++) console.log(i)").ok, false);
  assert.throws(() => run('return "a".repeat(140000)'), ExecutionLimitError);
});
test("linear memory maximum is enforced", () => {
  assert.equal(run("return new Uint8Array(80 * 1024 * 1024).length").ok, false);
});
