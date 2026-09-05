import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const cli = resolve("packages/cli/bin/cli.mjs");
const run = (...args) =>
  execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
for (const runtime of ["javascript", "python", "perl", "ruby"])
  test(`shared CLI: ${runtime} configuration and license guidance`, () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-cli-")),
      dir = join(root, runtime);
    const output = run("init", runtime, dir);
    assert.match(output, /LICENSE and THIRD_PARTY_NOTICES/);
    const config = JSON.parse(
      readFileSync(join(dir, "wrangler.jsonc"), "utf8"),
    );
    assert.equal(config.name, `sandbox-${runtime}`);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.match(
      readFileSync(join(dir, "index.js"), "utf8"),
      new RegExp("@sandbox-workers/" + runtime),
    );
    assert.match(
      readFileSync(join(dir, "README.md"), "utf8"),
      new RegExp("packages/" + runtime + "/LICENSE"),
    );
    assert.throws(() => run("init", runtime, dir), /Refusing to overwrite/);
  });
test("shared CLI: rejects unknown engines and dangling symlink overwrites", () => {
  assert.throws(() => run("init", "php"), /Command failed/);
  const dir = mkdtempSync(join(tmpdir(), "sandbox-cli-symlink-"));
  symlinkSync("/nonexistent-sandbox-target", join(dir, "index.js"));
  assert.throws(() => run("init", "python", dir), /Refusing to overwrite/);
});
