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
    const indexSource = readFileSync(join(dir, "index.js"), "utf8");
    assert.match(indexSource, new RegExp("@sandbox-workers/" + runtime));
    // Code contexts (a Durable Object-backed REPL) are wired for every
    // language except Ruby; see docs/sdk-parity-design.md.
    if (runtime === "ruby") {
      assert.equal(config.durable_objects, undefined);
      assert.equal(config.migrations, undefined);
      assert.doesNotMatch(indexSource, /Sandbox\b/);
    } else {
      assert.deepEqual(config.durable_objects, {
        bindings: [{ name: "SANDBOX", class_name: "Sandbox" }],
      });
      assert.deepEqual(config.migrations, [
        { tag: "v1", new_sqlite_classes: ["Sandbox"] },
      ]);
      assert.match(indexSource, /Sandbox/);
    }
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
