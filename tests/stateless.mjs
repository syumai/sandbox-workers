// End-to-end test for a stateless runtime deployment (no INTERPRETER
// Durable Object binding; see docs/sandbox-1-0-design.md, "Ruby" /
// stateless deployments) against a real `wrangler dev` process:
// tests/fixtures/stateless/worker.ts is the caller Worker, bound via a
// plain Service Binding (SANDBOX_SERVICE) to a runtime Worker built from
// the javascript package WITHOUT an INTERPRETER Durable Object binding
// (tests/fixtures/stateless/engine-entry.ts / engine-wrangler.jsonc).
//
// How to run:
//   pnpm run build:packages
//   pnpm run dev:stateless        # in one terminal
//   pnpm run test:stateless       # in another
import assert from "node:assert/strict";

const base = process.env.SANDBOX_URL ?? "http://localhost:8799";
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
  JSON.stringify(summary.r1.results) === JSON.stringify([{ text: "144" }]),
  `runCode() with envVars computes the expected result (got ${JSON.stringify(summary.r1.results)})`,
);
check(
  JSON.stringify(summary.r1.stdouts) === JSON.stringify(["12"]),
  `onStdout captured the console.log output (got ${JSON.stringify(summary.r1.stdouts)})`,
);
check(
  JSON.stringify(summary.resultFormats) === JSON.stringify([["text"]]),
  `onResult fired once for r1's result (got ${JSON.stringify(summary.resultFormats)})`,
);
check(
  summary.ts.status === 200 && JSON.stringify(summary.ts.results) === JSON.stringify([{ text: "2" }]),
  `the runtime's own POST /execute accepts language: "ts" and runs it on the javascript runtime (got ${JSON.stringify(summary.ts)})`,
);
check(
  summary.pythonRejected?.status === 400 && summary.pythonRejected?.code === "VALIDATION_FAILED",
  `POST /execute rejects language: "python" on this runtime (got ${JSON.stringify(summary.pythonRejected)})`,
);
check(
  summary.guestError.errorName === "SyntaxError" && summary.guestError.results.length === 0,
  `a guest error surfaces in result.error rather than throwing (got ${JSON.stringify(summary.guestError)})`,
);
check(
  summary.interpreterInfo?.language === "javascript" && summary.interpreterInfo?.contexts === false,
  `GET /interpreter reports contexts: false with no INTERPRETER binding (got ${JSON.stringify(summary.interpreterInfo)})`,
);
check(summary.contexts.status === 400, "POST /interpreters/x/contexts answers 400 with no INTERPRETER binding");
check(
  /no INTERPRETER Durable Object binding/.test(summary.contexts.message),
  `the 400 explains there is no INTERPRETER binding (got ${JSON.stringify(summary.contexts.message)})`,
);

console.log(`${checks} checks passed`);
