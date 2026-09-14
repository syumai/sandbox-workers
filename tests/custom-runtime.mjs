// End-to-end test for a third-party runtime Worker built on
// @sandbox-workers/interpreter (tests/fixtures/custom-runtime/runtime.ts, a
// stateless-only "calc" engine -- no code in this repo's own build
// pipeline) against a real `wrangler dev` process: worker.ts is the caller
// Worker, bound via a plain Service Binding (CALC) to the runtime Worker.
// Mirrors tests/stateless.mjs. See packages/interpreter/README.md.
//
// How to run:
//   pnpm run dev:custom-runtime        # in one terminal
//   pnpm run test:custom-runtime       # in another
import assert from "node:assert/strict";

const base = process.env.SANDBOX_URL ?? "http://localhost:8800";
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`  ok - ${message}`);
}

const res = await fetch(base);
if (res.status !== 200) {
  const body = await res.text();
  throw new Error(`unexpected status ${res.status}: ${body}`);
}
const summary = await res.json();

check(
  JSON.stringify(summary.r1.results) === JSON.stringify([{ text: "7" }]),
  `runCode() evaluates "1 + 2 * 3" (got ${JSON.stringify(summary.r1)})`,
);
check(
  JSON.stringify(summary.r2.results) === JSON.stringify([{ text: "42" }]),
  `envVars flow through to env.X (got ${JSON.stringify(summary.r2)})`,
);
check(
  summary.r3.error?.name === "SyntaxError" && summary.r3.results.length === 0,
  `a guest error (division by zero) surfaces as result.error rather than throwing (got ${JSON.stringify(summary.r3)})`,
);
check(
  summary.interpreterInfo?.language === "calc" &&
    summary.interpreterInfo?.contexts === false &&
    summary.interpreterInfo?.protocol === 1,
  `GET /interpreter reports language "calc", contexts: false, and protocol: 1 (got ${JSON.stringify(summary.interpreterInfo)})`,
);
check(
  summary.createContextRejected?.isValidationFailedError === true,
  `createCodeContext against a contexts: false binding throws ValidationFailedError (got ${JSON.stringify(summary.createContextRejected)})`,
);
check(
  JSON.stringify(summary.r4.results) === JSON.stringify([{ text: "42" }]),
  `sandbox.interpreter.runCode({ binding }) falls back to the stateless path (got ${JSON.stringify(summary.r4)})`,
);
check(summary.r4.hasContext === false, "the stateless fallback result has no context field");

console.log(`${checks} checks passed`);
