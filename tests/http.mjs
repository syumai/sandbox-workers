import assert from "node:assert/strict";
const base = process.env.SANDBOX_URL ?? "http://localhost:8787";
async function post(payload, status = 200, path = "/execute") {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, status);
  return res.json();
}
assert.deepEqual(
  (
    await post({
      code: "console.log(process.env.X); await Promise.resolve(Number(process.env.X) ** 2)",
      envVars: { X: "12" },
    })
  ).results,
  [{ text: "144" }],
);
assert.equal(
  (await post({ code: "while(true){}" })).error.name,
  "ExecutionLimitError",
);
assert.deepEqual((await post({ code: "5" })).results, [{ text: "5" }]);
assert.equal((await post({ code: "return (;" })).error.name, "SyntaxError");
await post({ code: "echo 1;" }, 400, "/execute/php");
await post({ code: "1" }, 400, "/execute/__proto__");
await post({ code: "" }, 400);
await post({ code: "あ".repeat(22000) }, 413);
await post({ code: "1", input: { x: 1 } }, 400);
await post({ code: "1", envVars: "not an object" }, 400);
await post({ code: "1", envVars: { X: 1 } }, 400);
await post({ code: "1", language: "javascript" }, 400);
for (const [method, body, type, expected] of [
  ["GET", undefined, undefined, 405],
  ["POST", "{", "application/json", 400],
  ["POST", "{}", "text/plain", 415],
]) {
  const res = await fetch(`${base}/execute`, {
    method,
    body,
    headers: type ? { "content-type": type } : {},
  });
  assert.equal(res.status, expected);
}
assert.equal(
  (await (await fetch(`${base}/languages`)).json()).languages[0].id,
  "javascript",
);
assert.match(await (await fetch(base)).text(), /sandbox-workers/);
console.log("17 HTTP checks passed against " + base);

for (const [language, code] of [
  ["python", "import os\nint(os.environ['X']) ** 2"],
  ["perl", "$ENV{X} ** 2;"],
  ["ruby", "ENV['X'].to_i ** 2"],
]) {
  const r = await post({ code, envVars: { X: "12" } }, 200, `/execute/${language}`);
  assert.deepEqual(r.results, [{ text: "144" }]);
  console.log(language + " HTTP passed");
}
