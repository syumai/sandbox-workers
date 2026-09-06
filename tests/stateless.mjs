// End-to-end test for stateless mode (see docs/sdk-parity-design.md,
// "Stateless mode") against a real `wrangler dev` process:
// tests/fixtures/stateless/worker.ts is the caller Worker, bound via a plain
// Service Binding (SANDBOX_SERVICE) to a runtime Worker built from the
// javascript package WITHOUT a SANDBOX Durable Object binding
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
  JSON.stringify(summary.ts.results) === JSON.stringify([{ text: "2" }]),
  `language: "ts" is accepted and runs on the javascript runtime (got ${JSON.stringify(summary.ts.results)})`,
);
check(
  summary.pythonRejected?.isClass === true && summary.pythonRejected?.code === "VALIDATION_FAILED",
  `language: "python" is rejected with a ValidationFailedError (got ${JSON.stringify(summary.pythonRejected)})`,
);
check(
  summary.guestError.errorName === "SyntaxError" && summary.guestError.results.length === 0,
  `a guest error surfaces in result.error rather than throwing (got ${JSON.stringify(summary.guestError)})`,
);
check(
  summary.exec.status === 200,
  "the runtime's context-less POST /sandboxes/x/execute succeeds with no SANDBOX binding",
);
check(
  JSON.stringify(summary.exec.results) === JSON.stringify([{ text: "2" }]),
  `.../execute returns the expected result (got ${JSON.stringify(summary.exec.results)})`,
);
check(summary.contexts.status === 400, "POST /sandboxes/x/contexts answers 400 with no SANDBOX binding");
check(
  /no SANDBOX Durable Object binding/.test(summary.contexts.message),
  `the 400 explains there is no SANDBOX binding (got ${JSON.stringify(summary.contexts.message)})`,
);

console.log(`${checks} checks passed`);
