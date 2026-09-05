import assert from "node:assert/strict";
const base = process.env.COMPUTER_URL ?? "http://localhost:8797";
for (const language of ["javascript", "python", "perl", "ruby"]) {
  const response = await fetch(`${base}/demo?language=${language}`, { method: "POST" });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const result = JSON.parse(text);
  assert.equal(result.execution.ok, true);
  assert.deepEqual(result.execution.result, { total: 3400, count: 2 });
  assert.deepEqual(result.files, ["/input.json", "/program.txt", "/result.json"]);
  console.log(`${language}: persisted input → Service Binding → persisted result passed`);
}
assert.equal((await fetch(`${base}/demo?language=__proto__`, { method: "POST" })).status, 400);
assert.equal((await fetch(`${base}/demo`)).status, 405);
console.log("Computer example HTTP checks passed");
