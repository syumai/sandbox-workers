import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runJavaScript, createJavaScriptSession, ExecutionLimitError } from "../runtime/javascript.mjs";
import { transformForAsyncExecution, transformForRepl } from "../packages/javascript/src/transform.mjs";
import { Workspace } from "../runtime/workspace.mjs";
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

test("the shipped TypeScript example executes without error", () => {
  const result = run(
    readFileSync(new URL("../examples/typescript.ts", import.meta.url), "utf8"),
    { NAME: "world" },
  );
  assert.equal(result.error, undefined);
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

test("transformForAsyncExecution strips TypeScript-only syntax and rewrites the result", () => {
  assert.equal(
    transformForAsyncExecution("const x: number = 1;\nx"),
    "(async () => {\nconst x = 1;\nreturn (x)\n})()",
  );
  assert.equal(
    transformForAsyncExecution("interface P { n: number }\nconst p: P = { n: 1 }; p"),
    "(async () => {\n\nconst p = { n: 1 }; return (p)\n})()",
  );
});

test("transformForAsyncExecution parses JavaScript first, so valid JS never changes meaning", () => {
  // `a < b > (c)` is a valid (if useless) JavaScript comparison chain. It
  // must never be reinterpreted as a generic function call `a<b>(c)`, which
  // is what a TypeScript-first parser would do.
  assert.equal(
    transformForAsyncExecution("a < b > (c)"),
    "(async () => {\nreturn (a < b > (c))\n})()",
  );
});

test("transformForAsyncExecution falls through to a raw wrap on a TypeScript syntax error", () => {
  // Not valid JavaScript and not valid TypeScript either: sucrase throws,
  // so the ORIGINAL code is wrapped raw so SpiderMonkey reports the real
  // SyntaxError against what the caller submitted.
  assert.equal(
    transformForAsyncExecution("const x: = 1"),
    "(async () => {\nconst x: = 1\n})()",
  );
});

test("transformForAsyncExecution rejects a top-level return in TypeScript code", () => {
  const illegalReturn =
    '(async () => { throw new SyntaxError("Illegal return statement"); })()';
  assert.equal(
    transformForAsyncExecution("interface P { n: number }\nreturn 1"),
    illegalReturn,
  );
});

test("the engine runs TypeScript by stripping types, with no type checking", () => {
  assert.deepEqual(
    run(
      "interface P { n: number }\nconst p: P = { n: 2 }\nfunction sq<T extends number>(x: T): number { return x * x }\np.n = sq(p.n)\np",
    ).results,
    [{ json: { n: 4 } }],
  );
  assert.equal(
    run("enum Color { Red, Green }\nColor.Green").results[0].text,
    "1",
  );
  assert.equal(
    run('const s = "x" satisfies string; s').results[0].text,
    "'x'",
  );
  // Types are stripped, not checked: this is a type error, but it still
  // runs like any other dynamically-typed JavaScript mistake.
  assert.equal(
    run('const n: number = "s"; n').results[0].text,
    "'s'",
  );
});

test("a TypeScript syntax error is reported as a guest-side SyntaxError", () => {
  const result = run("const x: = 1");
  assert.equal(result.error.name, "SyntaxError");
});

// ---- transformForRepl (session REPL transform) --------------------------

test("transformForRepl only rewrites the last expression when there is no top-level await", () => {
  const result = transformForRepl("let x = 1; x + 1");
  assert.equal(result.mode, "capture");
  assert.equal(result.code, "let x = 1; globalThis.__sandboxSession.setResult(x + 1);");
});

test("transformForRepl hoists declarations into an async IIFE when top-level await is present", () => {
  const result = transformForRepl("let x = 1; await Promise.resolve(); x");
  assert.equal(result.mode, "hoist");
  assert.match(result.code, /^var x;/);
  assert.match(result.code, /\(x = 1\)/);
  assert.match(result.code, /globalThis\.__sandboxSession\.setResult\(x\)/);
});

test("transformForRepl leaves a top-level return as raw source (a real SyntaxError from js_eval)", () => {
  assert.deepEqual(transformForRepl("return 1"), { mode: "raw", code: "return 1" });
  assert.deepEqual(transformForRepl("await 1; return 1"), {
    mode: "raw",
    code: "await 1; return 1",
  });
});

// ---- createJavaScriptSession (durable sessions, phase 1) -----------------

function makeSession(cwd = "/workspace") {
  const workspace = new Workspace();
  const cwdChanges = [];
  const session = createJavaScriptSession(module, {
    workspace,
    cwd,
    onCwdChange: (next) => cwdChanges.push(next),
  });
  return { session, workspace, cwdChanges };
}

test("session: var/let/const/class declarations persist across executions", () => {
  const { session } = makeSession();
  session.execute({ code: "var a = 1; let b = 2; const c = 3; class D { hi() { return 4; } }" });
  const result = session.execute({ code: "a + b + c + new D().hi()" });
  assert.deepEqual(result.results, [{ text: "10" }]);
});

test("session: a top-level await still persists declarations", () => {
  const { session } = makeSession();
  session.execute({ code: "let z = 5; await Promise.resolve(); z" });
  const result = session.execute({ code: "z" });
  assert.deepEqual(result.results, [{ text: "5" }]);
});

test("session: fs is backed by the shared workspace, visible to the HTTP files API", () => {
  const { session, workspace } = makeSession();
  session.execute({ code: 'fs.writeFileSync("/workspace/a.txt", "hi")' });
  assert.equal(workspace.read("/workspace/a.txt", "/workspace").content, "hi");
  workspace.write("/workspace/b.txt", "/workspace", "from host");
  const result = session.execute({ code: 'fs.readFileSync("/workspace/b.txt", "utf8")' });
  assert.deepEqual(result.results, [{ text: "'from host'" }]);
});

test("session: fs errors surface as real Error instances with a Node-style .code", () => {
  const { session } = makeSession();
  const result = session.execute({
    code:
      'let code; try { fs.readFileSync("/workspace/missing.txt", "utf8"); } catch (e) { code = e.code; } code',
  });
  assert.deepEqual(result.results, [{ text: "'ENOENT'" }]);
});

test("session: process.cwd()/chdir persist and call onCwdChange", () => {
  const { session, cwdChanges } = makeSession();
  session.execute({ code: 'fs.mkdirSync("/workspace/sub"); process.chdir("sub")' });
  const result = session.execute({ code: "process.cwd()" });
  assert.deepEqual(result.results, [{ text: "'/workspace/sub'" }]);
  assert.equal(session.cwd, "/workspace/sub");
  assert.ok(cwdChanges.includes("/workspace/sub"));
});

test("session: import() is served from the workspace", () => {
  const { session } = makeSession();
  session.execute({ code: 'fs.writeFileSync("/workspace/lib.mjs", "export const v = 7;")' });
  const result = session.execute({ code: 'const m = await import("./lib.mjs"); m.v' });
  assert.deepEqual(result.results, [{ text: "7" }]);
});

test("session: fuel exhaustion is reported without invalidating the instance", () => {
  const { session } = makeSession();
  session.execute({ code: "var survivor = 42" });
  assert.throws(() => session.execute({ code: "while (true) {}" }), ExecutionLimitError);
  const result = session.execute({ code: "survivor" });
  assert.deepEqual(result.results, [{ text: "42" }]);
});

test("session: an ordinary guest exception does not clobber prior globals", () => {
  const { session } = makeSession();
  session.execute({ code: "var kept = 1" });
  const failed = session.execute({ code: "null.x" });
  assert.equal(failed.error.name, "TypeError");
  const result = session.execute({ code: "kept" });
  assert.deepEqual(result.results, [{ text: "1" }]);
});

// ---- workspace.disabled: guest /workspace lockout (runtime/wasi.mjs) -----

test("session: workspace.disabled gates fs.* with EACCES", () => {
  const { session, workspace } = makeSession();
  workspace.disabled = true;

  // Each `let` below uses a fresh name -- the session persists top-level
  // declarations across execute() calls (see the earlier "var/let/const ..."
  // test), so redeclaring the same `let` in a later call would itself be a
  // SyntaxError.
  const write = session.execute({
    code: 'let codeW; try { fs.writeFileSync("/workspace/a.txt", "x"); } catch (e) { codeW = e.code; } codeW',
  });
  assert.deepEqual(write.results, [{ text: "'EACCES'" }]);

  const read = session.execute({
    code: 'let codeR; try { fs.readFileSync("/workspace/a.txt", "utf8"); } catch (e) { codeR = e.code; } codeR',
  });
  assert.deepEqual(read.results, [{ text: "'EACCES'" }]);

  const exists = session.execute({ code: 'fs.existsSync("/workspace/a.txt")' });
  assert.deepEqual(exists.results, [{ text: "false" }]);
});

test("session: workspace.disabled keeps process.cwd() at /workspace and rejects chdir", () => {
  const { session, workspace } = makeSession();
  workspace.disabled = true;

  const cwd = session.execute({ code: "process.cwd()" });
  assert.deepEqual(cwd.results, [{ text: "'/workspace'" }]);

  const chdir = session.execute({
    code: 'let code; try { process.chdir("sub"); } catch (e) { code = e.code; } code',
  });
  assert.deepEqual(chdir.results, [{ text: "'EACCES'" }]);
});

test("session: workspace.disabled is read live, not captured at session boot", () => {
  const { session, workspace } = makeSession();
  workspace.disabled = true;
  const denied = session.execute({
    code: 'let code; try { fs.writeFileSync("/workspace/a.txt", "x"); } catch (e) { code = e.code; } code',
  });
  assert.deepEqual(denied.results, [{ text: "'EACCES'" }]);

  workspace.disabled = false;
  const allowed = session.execute({
    code: 'fs.writeFileSync("/workspace/a.txt", "x"); fs.readFileSync("/workspace/a.txt", "utf8")',
  });
  assert.deepEqual(allowed.results, [{ text: "'x'" }]);
  assert.equal(allowed.error, undefined);
});
