// Pure Node tests for `InterpreterClient` (packages/core/src/interpreter-
// client.ts), specifically the wire protocol version check in `info()` (see
// docs/sandbox-1-0-design.md, "Wire protocol: sandbox Durable Object ->
// runtime Worker" and tmp/interpreter-core-split-design.md 5.4). Run
// `pnpm --filter @sandbox-workers/core build` first; this imports the built
// package, not the TypeScript source.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  InterpreterClient,
  INTERPRETER_PROTOCOL_VERSION,
} from "../packages/core/dist/index.js";

function makeBinding(info) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/interpreter")
        return new Response(JSON.stringify(info), {
          headers: { "content-type": "application/json" },
        });
      return new Response("not found", { status: 404 });
    },
  };
}

test("info(): a missing protocol field is treated as version 1 and accepted", async () => {
  const binding = makeBinding({ language: "javascript", engine: "SpiderMonkey", contexts: true });
  const client = new InterpreterClient(binding, "JAVASCRIPT");
  const info = await client.info();
  assert.equal(info.language, "javascript");
  assert.equal(info.protocol, undefined);
});

test("info(): protocol === INTERPRETER_PROTOCOL_VERSION is accepted", async () => {
  const binding = makeBinding({
    language: "javascript",
    engine: "SpiderMonkey",
    contexts: true,
    protocol: INTERPRETER_PROTOCOL_VERSION,
  });
  const client = new InterpreterClient(binding, "JAVASCRIPT");
  const info = await client.info();
  assert.equal(info.protocol, INTERPRETER_PROTOCOL_VERSION);
});

test("info(): a newer protocol version is rejected with a 400 ApiError naming both versions", async () => {
  const binding = makeBinding({
    language: "javascript",
    engine: "SpiderMonkey",
    contexts: true,
    protocol: 2,
  });
  const client = new InterpreterClient(binding, "JAVASCRIPT");
  await assert.rejects(
    () => client.info(),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.match(
        error.message,
        /Binding 'JAVASCRIPT' speaks interpreter protocol 2; this caller supports 1/,
      );
      return true;
    },
  );
});

test("info(): a non-number protocol field fails the InterpreterInfo shape check", async () => {
  const binding = makeBinding({
    language: "javascript",
    engine: "SpiderMonkey",
    contexts: true,
    protocol: "1",
  });
  const client = new InterpreterClient(binding, "JAVASCRIPT");
  await assert.rejects(
    () => client.info(),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /not a sandbox-workers runtime Worker/);
      return true;
    },
  );
});

test("constructor: throws ApiError 'Unknown binding' when the target has no fetch function", () => {
  assert.throws(
    () => new InterpreterClient(undefined, "MISSING"),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Unknown binding 'MISSING'/);
      return true;
    },
  );
});

test("isBindingName(): matches the same shape createCodeContext validates binding names against", () => {
  assert.equal(InterpreterClient.isBindingName("JAVASCRIPT"), true);
  assert.equal(InterpreterClient.isBindingName("_python3"), true);
  assert.equal(InterpreterClient.isBindingName("1INVALID"), false);
  assert.equal(InterpreterClient.isBindingName("has-dash"), false);
});
