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
    // Code contexts (an Interpreter Durable Object backing memory
    // snapshots) are wired for every language except Ruby; see
    // docs/sandbox-1-0-design.md.
    if (runtime === "ruby") {
      assert.equal(config.durable_objects, undefined);
      assert.equal(config.migrations, undefined);
      assert.doesNotMatch(indexSource, /Interpreter\b/);
    } else {
      assert.deepEqual(config.durable_objects, {
        bindings: [{ name: "INTERPRETER", class_name: "Interpreter" }],
      });
      assert.deepEqual(config.migrations, [
        { tag: "v1", new_sqlite_classes: ["Interpreter"] },
      ]);
      assert.match(indexSource, /Interpreter/);
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      assert.match(readme, /export \{ Sandbox \} from "@sandbox-workers\/core";/);
      assert.match(readme, /getSandbox\(env\.Sandbox, "user-42"\)/);
      assert.match(
        readme,
        new RegExp(
          `sandbox\\.interpreter\\.createCodeContext\\(\\{ binding: "${runtime.toUpperCase()}"`,
        ),
      );
      assert.match(readme, /INTERPRETER_IDLE_TTL_MS/);
      assert.match(readme, /SANDBOX_IDLE_TTL_MS/);
    }
    assert.match(
      readFileSync(join(dir, "README.md"), "utf8"),
      new RegExp("packages/" + runtime + "/LICENSE"),
    );
    assert.throws(() => run("init", runtime, dir), /Refusing to overwrite/);
  });
for (const runtime of ["javascript", "python", "perl"])
  test(`shared CLI: --stateless ${runtime} has no durable_objects/migrations and no Interpreter export`, () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-cli-stateless-"));
    // --stateless may appear before or after the directory argument.
    const beforeDir = join(root, `${runtime}-before`);
    run("init", runtime, "--stateless", beforeDir);
    const afterDir = join(root, `${runtime}-after`);
    const output = run("init", runtime, afterDir, "--stateless");
    for (const dir of [beforeDir, afterDir]) {
      const config = JSON.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8"));
      assert.equal(config.durable_objects, undefined);
      assert.equal(config.migrations, undefined);
      const indexSource = readFileSync(join(dir, "index.js"), "utf8");
      assert.doesNotMatch(indexSource, /Interpreter\b/);
      assert.match(indexSource, new RegExp("@sandbox-workers/" + runtime));
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      assert.match(readme, /this Worker only serves stateless execution/);
      assert.match(readme, /import \{ runCode \} from "@sandbox-workers\/core";/);
      assert.match(readme, /runCode\(env\.SANDBOX, "1 \+ 1"\)/);
    }
    assert.match(output, /LICENSE and THIRD_PARTY_NOTICES/);
  });

test("shared CLI: rejects unknown engines and dangling symlink overwrites", () => {
  assert.throws(() => run("init", "php"), /Command failed/);
  const dir = mkdtempSync(join(tmpdir(), "sandbox-cli-symlink-"));
  symlinkSync("/nonexistent-sandbox-target", join(dir, "index.js"));
  assert.throws(() => run("init", "python", dir), /Refusing to overwrite/);
});
