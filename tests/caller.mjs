// End-to-end test for the typed @sandbox-workers/core client against a real
// `wrangler dev` process, using tests/fixtures/caller as the caller Worker
// (hosting its own Sandbox Durable Object) bound to two runtime Workers,
// engine/wrangler.jsonc (sandbox-engine-javascript, JAVASCRIPT) and
// engine/wrangler-python.jsonc (sandbox-engine-python, PYTHON). See
// docs/sandbox-1-0-design.md, "Model" and "Tests".
//
// How to run:
//   pnpm run build:packages
//   pnpm run dev:caller        # in one terminal
//   pnpm run test:caller       # in another
import assert from "node:assert/strict";

const base = process.env.SANDBOX_URL ?? "http://localhost:8798";
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`  ok - ${message}`);
}

const id = `caller-e2e-${Date.now()}`;
const res = await fetch(`${base}/?id=${id}`);
if (res.status !== 200) {
  const body = await res.text();
  throw new Error(`unexpected status ${res.status}: ${body}`);
}
const summary = await res.json();

check(
  JSON.stringify(summary.write.results) === JSON.stringify([{ text: "null" }]),
  `fs.writeFileSync returns undefined, reported as the last-expression result (got ${JSON.stringify(summary.write.results)})`,
);
check(
  JSON.stringify(summary.read.results) === JSON.stringify([{ text: "'from js: s/js'" }]),
  `a Python context reads a file written by a JavaScript context via fs.writeFileSync (got ${JSON.stringify(summary.read.results)})`,
);

check(summary.defaultContext.sameAsJs === true, "the default context for JAVASCRIPT reuses the explicitly created js context");
check(summary.defaultContext.sameAcrossCalls === true, "two context-less runCode calls against the same binding reuse the same context");
check(JSON.stringify(summary.defaultContext.r1) === JSON.stringify([{ text: "2" }]), "default-context call 1 + 1");
check(JSON.stringify(summary.defaultContext.r2) === JSON.stringify([{ text: "4" }]), "default-context call 2 + 2");

check(
  summary.contextNotFound?.isClass === true && summary.contextNotFound?.code === "CONTEXT_NOT_FOUND",
  `deleteCodeContext on a bogus id rejects with ContextNotFoundError (got ${JSON.stringify(summary.contextNotFound)})`,
);
check(
  summary.unknownBinding?.isClass === true && summary.unknownBinding?.code === "VALIDATION_FAILED",
  `createCodeContext with an unknown binding rejects with ValidationFailedError (got ${JSON.stringify(summary.unknownBinding)})`,
);
check(
  summary.noTarget?.isClass === true && summary.noTarget?.code === "VALIDATION_FAILED",
  `runCode() without a context or a binding rejects with ValidationFailedError (got ${JSON.stringify(summary.noTarget)})`,
);

check(
  JSON.stringify(summary.env.before) === JSON.stringify([{ text: "'s'" }]),
  `setEnvVars({ SB: "s" }) is visible in the js context (got ${JSON.stringify(summary.env.before)})`,
);
check(
  JSON.stringify(summary.env.after) === JSON.stringify([{ text: "'unset'" }]),
  `setEnvVars({ SB: undefined }) unsets the var (got ${JSON.stringify(summary.env.after)})`,
);

check(summary.files.content === "hello", "writeFile/readFile round trip through the files API");
check(summary.files.listed.includes("/workspace/api.txt"), "listFiles sees the file written through the files API");
check(summary.files.listed.includes("/workspace/shared.txt"), "listFiles sees the file written by the js context's guest code");

check(summary.info.contextCount === 2, `getInfo() reports both contexts before cleanup (got ${summary.info.contextCount})`);
check(
  JSON.stringify(summary.info.bindings) === JSON.stringify(["JAVASCRIPT", "PYTHON"]),
  `getInfo().contexts carry a binding per context (got ${JSON.stringify(summary.info.bindings)})`,
);
check(summary.infoAfterDestroy.contextCount === 0, "getInfo() after destroy() reports a fresh, empty sandbox");

console.log(`${checks} checks passed`);
