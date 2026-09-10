// Runs @sandbox-workers/interpreter's `runEngineConformance` (packages/
// interpreter/src/testing.ts) against the real `Engine` each of this repo's
// four language packages builds -- constructed exactly the way each
// packages/<lang>/src/worker.ts does (see tmp/interpreter-core-split-design.md
// section 5.1/8 phase 5). This both exercises the conformance suite itself
// against real Wasm engines and gives the four in-repo packages the same
// contract check a third-party runtime is meant to run.
//
// Like tests/sessions.test.mjs/tests/languages.test.mjs, engine.wasm/
// stdlib.bin are read from each package's `dist/` (built by
// `build:languages`), and engine-build.json/metadata are read straight from
// `src/` so this file doesn't require `build:packages` to have run first --
// only `@sandbox-workers/interpreter` itself needs to be built (`pnpm test`'s
// own pre-step already does that).
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runEngineConformance } from "@sandbox-workers/interpreter/testing";
import { runWasmify, bootWasmifySession, restoreWasmifySession } from "@sandbox-workers/interpreter/wasmify";
import {
  runJavaScript,
  createJavaScriptSession,
  restoreJavaScriptSession,
} from "../packages/javascript/src/engine.mjs";
import { pythonDriver } from "../packages/python/src/engine.mjs";
import { perlDriver } from "../packages/perl/src/engine.mjs";
import { runRuby } from "../packages/ruby/src/engine.mjs";

// Each engine's own resource limits (packages/<lang>/src/metadata.ts
// `limits`), inlined rather than importing the built dist/metadata.js -- see
// the module comment above.
const LIMITS = {
  javascript: { codeBytes: 65536, requestBytes: 98304, fuel: 50_000_000, memoryBytes: 67108864 },
  python: { codeBytes: 65536, requestBytes: 98304, fuel: 100_000_000, memoryBytes: 67108864 },
  perl: { codeBytes: 65536, requestBytes: 98304, fuel: 10_000_000, memoryBytes: 67108864 },
  ruby: { codeBytes: 65536, requestBytes: 98304, fuel: 30_000_000, memoryBytes: 100663296 },
};

function loadBuild(language) {
  return JSON.parse(readFileSync(`packages/${language}/src/engine-build.json`, "utf8")).sha256;
}
function loadWasm(language) {
  return new WebAssembly.Module(readFileSync(`packages/${language}/dist/engine.wasm`));
}
function loadArchive(language) {
  return readFileSync(`packages/${language}/dist/stdlib.bin`);
}

test("javascript engine passes runEngineConformance", async () => {
  const wasm = loadWasm("javascript");
  const limits = LIMITS.javascript;
  const engine = {
    language: "javascript",
    engineName: "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6",
    build: loadBuild("javascript"),
    limits,
    run: (payload) => runJavaScript(wasm, payload, limits),
    sessions: {
      boot: (options) => createJavaScriptSession(wasm, options, limits),
      restore: (options, snapshot) => restoreJavaScriptSession(wasm, options, snapshot, limits),
    },
  };
  await runEngineConformance(engine, {
    programs: {
      simple: { code: "1 + 1", expectResultText: "2" },
      // Top-level `return` is rejected like the Cloudflare Sandbox SDK
      // (tests/engine.test.mjs) -- a guest SyntaxError, not a throw.
      error: { code: "return 1" },
      stateful: { define: "var counter = 1;", use: "counter + 1", expectResultText: "2" },
    },
  });
});

test("python engine passes runEngineConformance", async () => {
  const wasm = loadWasm("python");
  const archive = loadArchive("python");
  const limits = LIMITS.python;
  const engine = {
    language: "python",
    engineName: "CPython 3.14.6 / goccy v0.2.0",
    build: loadBuild("python"),
    limits,
    run: (payload) => runWasmify(wasm, archive, pythonDriver, payload, limits),
    sessions: {
      boot: (options) => bootWasmifySession(wasm, archive, pythonDriver, options, limits),
      restore: (options, snapshot) => restoreWasmifySession(wasm, archive, pythonDriver, options, snapshot, limits),
    },
  };
  await runEngineConformance(engine, {
    programs: {
      simple: { code: "1 + 1", expectResultText: "2" },
      error: { code: 'raise ValueError("broken")' },
      stateful: { define: "counter = 1", use: "counter + 1", expectResultText: "2" },
    },
  });
});

test("perl engine passes runEngineConformance", async () => {
  const wasm = loadWasm("perl");
  const archive = loadArchive("perl");
  const limits = LIMITS.perl;
  const engine = {
    language: "perl",
    engineName: "Perl 5.42.2 / goccy v0.2.1",
    build: loadBuild("perl"),
    limits,
    run: (payload) => runWasmify(wasm, archive, perlDriver, payload, limits),
    sessions: {
      boot: (options) => bootWasmifySession(wasm, archive, perlDriver, options, limits),
      restore: (options, snapshot) => restoreWasmifySession(wasm, archive, perlDriver, options, snapshot, limits),
    },
  };
  await runEngineConformance(engine, {
    programs: {
      simple: { code: "1 + 1", expectResultText: "2" },
      error: { code: 'die "broken";' },
      stateful: { define: "our $counter = 1; 1;", use: "$counter + 1", expectResultText: "2" },
    },
  });
});

// Ruby has no `sessions` -- code contexts are not supported (see
// packages/ruby/src/engine.mjs and packages/ruby/src/worker.ts) -- so only
// stateless programs are given; runEngineConformance returns after the
// stateless/identity checks for an Engine with no `sessions`.
test("ruby engine (stateless-only) passes runEngineConformance", async () => {
  const wasm = loadWasm("ruby");
  const limits = LIMITS.ruby;
  const engine = {
    language: "ruby",
    engineName: "CRuby 4.0.0 / ruby.wasm 2.10.1",
    build: loadBuild("ruby"),
    limits,
    run: (payload) => runRuby(wasm, payload, limits),
  };
  await runEngineConformance(engine, {
    programs: {
      simple: { code: "1 + 1", expectResultText: "2" },
      error: { code: 'raise "boom"' },
    },
  });
});
