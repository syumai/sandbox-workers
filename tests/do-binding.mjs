// End-to-end test for the typed client's two transports (Durable Object
// namespace bound with script_name, and a plain Service Binding) against a
// real `wrangler dev` process, using tests/fixtures/do-binding as the caller
// Worker and engine/wrangler.jsonc (sandbox-engine-javascript) as the
// runtime Worker it binds to. See docs/sdk-parity-design.md, "Model".
//
// How to run:
//   pnpm run build:packages
//   pnpm run dev:do-binding        # in one terminal
//   pnpm run test:do-binding       # in another
import assert from "node:assert/strict";

const base = process.env.SANDBOX_URL ?? "http://localhost:8798";
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
  console.log(`  ok - ${message}`);
}

async function run(via, id) {
  const res = await fetch(`${base}/?via=${via}&id=${id}`);
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`${via}: unexpected status ${res.status}: ${body}`);
  }
  return res.json();
}

async function verify(via, summary) {
  check(
    JSON.stringify(summary.r1.results) === JSON.stringify([{ json: ["s", "c", "x"] }]),
    `${via}: r1.results layers sandbox/context/call envVars (got ${JSON.stringify(summary.r1.results)})`,
  );
  check(summary.r1.executionCount === 1, `${via}: r1.executionCount === 1`);
  check(
    JSON.stringify(summary.r2.results) === JSON.stringify([{ text: "42" }]),
    `${via}: r2.results reflects state persisted in the same context (got ${JSON.stringify(summary.r2.results)})`,
  );
  // The default context (no `context`/`contextId` given) resolves to the
  // first existing context whose language matches -- by this point that's
  // `ctx` itself, created above -- not a fresh, separate context (see
  // docs/sdk-parity-design.md, "Default context", and runtime/sandbox.mjs's
  // _resolveDefaultContext). So `dflt` still sees `n`.
  check(
    JSON.stringify(summary.dflt.results) === JSON.stringify([{ text: "'number'" }]),
    `${via}: dflt.results shows the default context reused ctx, not a fresh one (got ${JSON.stringify(summary.dflt.results)})`,
  );
  check(summary.dflt.contextId === summary.r1.contextId, `${via}: the default-context execute reused the same context id as ctx`);
  check(summary.sameContext === true, `${via}: r1.context.id === ctx.id`);
  check(summary.read.content === "hello", `${via}: readFile content survives writeFile -> mkdir -> moveFile`);
  check(summary.read.mimeType === "text/plain", `${via}: readFile mimeType is text/plain`);
  check(summary.list.includes("/workspace/dir"), `${via}: listFiles(recursive) includes /workspace/dir`);
  check(summary.list.includes("/workspace/dir/a.txt"), `${via}: listFiles(recursive) includes /workspace/dir/a.txt`);
  check(summary.ex.exists === false, `${via}: exists() is false for the moved-away path`);
  check(
    JSON.stringify(summary.notFound) ===
      JSON.stringify({ name: "FileNotFoundError", isClass: true, code: "FILE_NOT_FOUND", httpStatus: 404 }),
    `${via}: readFile on a missing path rejects with FileNotFoundError (got ${JSON.stringify(summary.notFound)})`,
  );
  // Only `ctx` was ever created: the context-less `dflt` call above reused
  // it as the default context rather than creating a second one.
  check(summary.contexts.length === 1, `${via}: listCodeContexts() reports the single context (ctx, reused as default)`);
  check(
    summary.contexts.every((c) => c.isDate === true),
    `${via}: every context's createdAt was converted to a Date`,
  );
  check(summary.contextsLength === 1, `${via}: getInfo().contexts.length === 1 before cleanup`);
  check(
    JSON.stringify(summary.results) === JSON.stringify([["json"]]),
    `${via}: onResult fired once, for r1's array result (got ${JSON.stringify(summary.results)})`,
  );
}

const failures = [];
for (const via of ["do", "service"]) {
  const id = `e2e-${via === "do" ? "do" : "svc"}-${Date.now()}`;
  console.log(`--- via=${via} id=${id} ---`);
  try {
    const summary = await run(via, id);
    await verify(via, summary);
  } catch (error) {
    failures.push({ via, error });
    console.error(`  FAILED - via=${via}: ${error.message}`);
  }
}

console.log(`${checks} checks passed`);
if (failures.length) {
  for (const { via, error } of failures) {
    console.error(`\n=== via=${via} failed ===`);
    console.error(error.stack ?? error.message);
    if (via === "service" && error.message.includes("RpcPromise"))
      console.error(
        "This looks like a regression of a real bug found while building this test: a " +
          "genuine Cloudflare Service Binding is an RPC-capable Fetcher stub where any " +
          "property access forms a speculative RPC call (Workers RPC's \"promise " +
          "pipelining\"), so `typeof fetcher.idFromName` is also \"function\", just like a " +
          "real DurableObjectNamespace. getSandbox()'s isNamespaceTarget() " +
          "(packages/core/src/client.ts) tells the two apart by checking that the " +
          "candidate stringifies as real function source rather than " +
          "\"[object JsRpcProperty]\" -- if that check regresses, requests over the " +
          "Service Binding transport get misrouted through the DurableObjectNamespace " +
          "code path and fail with exactly this DataCloneError.",
      );
  }
  process.exit(1);
}
