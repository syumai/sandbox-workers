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
      readFileSync(join(dir, `wrangler.${runtime}.jsonc`), "utf8"),
    );
    assert.equal(config.name, `sandbox-${runtime}`);
    assert.equal(config.main, `${runtime}.js`);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    const indexSource = readFileSync(join(dir, `${runtime}.js`), "utf8");
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
      assert.match(readme, /getSandbox<Env>\(env\.Sandbox, "user-42"\)/);
      assert.match(
        readme,
        new RegExp(
          `sandbox\\.interpreter\\.createCodeContext\\(\\{ binding: "${runtime.toUpperCase()}"`,
        ),
      );
      assert.match(readme, /INTERPRETER_IDLE_TTL_MS/);
      assert.match(readme, /SANDBOX_IDLE_TTL_MS/);
    }
    if (runtime === "ruby") {
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      assert.match(readme, /this Worker only serves stateless execution/);
      assert.match(readme, /import \{ runCode \} from "@sandbox-workers\/core";/);
      assert.match(readme, /runCode\(env\.RUBY, "1 \+ 1"\)/);
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
      const config = JSON.parse(
        readFileSync(join(dir, `wrangler.${runtime}.jsonc`), "utf8"),
      );
      assert.equal(config.durable_objects, undefined);
      assert.equal(config.migrations, undefined);
      const indexSource = readFileSync(join(dir, `${runtime}.js`), "utf8");
      assert.doesNotMatch(indexSource, /Interpreter\b/);
      assert.match(indexSource, new RegExp("@sandbox-workers/" + runtime));
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      assert.match(readme, /this Worker only serves stateless execution/);
      assert.match(readme, /import \{ runCode \} from "@sandbox-workers\/core";/);
      assert.match(
        readme,
        new RegExp(`runCode\\(env\\.${runtime.toUpperCase()}, "1 \\+ 1"\\)`),
      );
    }
    assert.match(output, /LICENSE and THIRD_PARTY_NOTICES/);
  });

test("shared CLI: rejects unknown engines and dangling symlink overwrites", () => {
  assert.throws(() => run("init", "php"), /Command failed/);
  const dir = mkdtempSync(join(tmpdir(), "sandbox-cli-symlink-"));
  symlinkSync("/nonexistent-sandbox-target", join(dir, "python.js"));
  assert.throws(() => run("init", "python", dir), /Refusing to overwrite/);
});

test("shared CLI: init javascript,python generates one config pair per runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-cli-multi-")),
    dir = join(root, "runtimes");
  run("init", "javascript,python", dir);
  const jsConfig = JSON.parse(
    readFileSync(join(dir, "wrangler.javascript.jsonc"), "utf8"),
  );
  const pyConfig = JSON.parse(
    readFileSync(join(dir, "wrangler.python.jsonc"), "utf8"),
  );
  assert.equal(jsConfig.name, "sandbox-javascript");
  assert.equal(pyConfig.name, "sandbox-python");
  readFileSync(join(dir, "javascript.js"), "utf8");
  readFileSync(join(dir, "python.js"), "utf8");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies, {
    "@sandbox-workers/javascript": pkg.dependencies["@sandbox-workers/javascript"],
    "@sandbox-workers/python": pkg.dependencies["@sandbox-workers/python"],
  });
  assert.equal(
    pkg.scripts.dev,
    "wrangler dev -c wrangler.javascript.jsonc -c wrangler.python.jsonc",
  );
  assert.equal(
    pkg.scripts.deploy,
    "wrangler deploy -c wrangler.javascript.jsonc && wrangler deploy -c wrangler.python.jsonc",
  );
  assert.equal(
    pkg.scripts["dry-run"],
    "wrangler deploy --dry-run -c wrangler.javascript.jsonc --outdir dist/javascript && wrangler deploy --dry-run -c wrangler.python.jsonc --outdir dist/python",
  );
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  assert.match(readme, /"binding": "JAVASCRIPT", "service": "sandbox-javascript"/);
  assert.match(readme, /"binding": "PYTHON", "service": "sandbox-python"/);
  assert.match(readme, /createCodeContext\(\{ binding: "JAVASCRIPT" \}\)/);
  assert.match(readme, /createCodeContext\(\{ binding: "PYTHON" \}\)/);
  assert.match(readme, /\/workspace\/result\.json/);
  assert.match(readme, /fs\.readFileSync\('\/workspace\/result\.json', 'utf8'\)/);
});

test("shared CLI: init javascript,ruby documents contexts for javascript and stateless runCode for ruby", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-cli-multi-")),
    dir = join(root, "runtimes");
  run("init", "javascript,ruby", dir);
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  assert.match(readme, /export \{ Sandbox \} from "@sandbox-workers\/core";/);
  assert.match(readme, /createCodeContext\(\{ binding: "JAVASCRIPT" \}\)/);
  assert.match(readme, /runCode\(env\.RUBY, "1 \+ 1"\)/);
  assert.match(readme, /this Worker only serves stateless execution/);
  const rubyConfig = JSON.parse(
    readFileSync(join(dir, "wrangler.ruby.jsonc"), "utf8"),
  );
  assert.equal(rubyConfig.durable_objects, undefined);
});

test("shared CLI: rejects a duplicate runtime in the list", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-cli-multi-")),
    dir = join(root, "runtimes");
  assert.throws(() => run("init", "python,python", dir), /Command failed/);
});

test("shared CLI: rejects an unknown runtime in the list", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-cli-multi-")),
    dir = join(root, "runtimes");
  assert.throws(() => run("init", "python,php", dir), /Command failed/);
});

test("shared CLI: --stateless before or after the directory disables contexts for every runtime in the list", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-cli-multi-stateless-"));
  const beforeDir = join(root, "before");
  run("init", "javascript,python", "--stateless", beforeDir);
  const afterDir = join(root, "after");
  run("init", "javascript,python", afterDir, "--stateless");
  for (const dir of [beforeDir, afterDir]) {
    for (const runtime of ["javascript", "python"]) {
      const config = JSON.parse(
        readFileSync(join(dir, `wrangler.${runtime}.jsonc`), "utf8"),
      );
      assert.equal(config.durable_objects, undefined);
      assert.equal(config.migrations, undefined);
      const source = readFileSync(join(dir, `${runtime}.js`), "utf8");
      assert.doesNotMatch(source, /Interpreter\b/);
    }
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    assert.doesNotMatch(readme, /Interpreter\b/);
  }
});

test("shared CLI: refuses to overwrite when only one generated file already exists", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-cli-multi-symlink-")),
    dir = join(root, "runtimes");
  // Plant a dangling symlink at the path of just one of the files the
  // multi-runtime init would write; the CLI's own mkdir(recursive) creates
  // the directory first.
  execFileSync("mkdir", ["-p", dir]);
  symlinkSync("/nonexistent-sandbox-target", join(dir, "python.js"));
  assert.throws(
    () => run("init", "javascript,python", dir),
    /Refusing to overwrite/,
  );
});
