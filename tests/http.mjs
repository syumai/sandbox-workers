import assert from "node:assert/strict";
const base = process.env.SANDBOX_URL ?? "http://localhost:8787";
async function post(payload, status = 200) {
  const res = await fetch(`${base}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, status);
  return res.json();
}
assert.equal(
  (
    await post({
      code: "console.log(input.x); return await Promise.resolve(input.x ** 2)",
      input: { x: 12 },
    })
  ).result,
  144,
);
assert.equal(
  (await post({ code: "while(true){}" }, 422)).error.name,
  "ExecutionLimitError",
);
assert.equal((await post({ code: "return 5" })).result, 5);
assert.equal((await post({ code: "return (;" })).error.name, "SyntaxError");
await post({ language: "php", code: "echo 1;" }, 400);
await post({ language: "__proto__", code: "1" }, 400);
await post({ code: "" }, 400);
await post({ code: "あ".repeat(22000) }, 413);
await post({ code: "return 1", input: "a".repeat(100000) }, 413);
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
console.log("14 HTTP checks passed against " + base);

for (const [language,code] of [["python","return input['x'] ** 2"],["perl","return $input->{x} ** 2;"],["ruby","return input['x'] ** 2"]]) {
 const r=await post({language,code,input:{x:12}});assert.equal(r.result,144);console.log(language+" HTTP passed");
}
