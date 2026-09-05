import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve("."),
  dir = await mkdtemp(join(tmpdir(), "sandbox-language-packages-"));
const run = (args, cwd = dir) =>
  execFileSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  });
const npmRun = (args, cwd) =>
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120000,
  });
for (const language of ["python", "perl", "ruby"]) {
  const { version } = JSON.parse(
    await readFile(`packages/${language}/package.json`, "utf8"),
  );
  const tarball = join(root, `dist/sandbox-workers-${language}-${version}.tgz`);
  const worker = join(dir, language);
  run([join(root, `packages/cli/bin/cli.mjs`), "init", language, worker]);
  assert.throws(
    () =>
      run([join(root, `packages/cli/bin/cli.mjs`), "init", language, worker]),
    /Refusing to overwrite/,
  );
  try {
    npmRun(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      worker,
    );
    const pkg = JSON.parse(
      await readFile(
        join(worker, `node_modules/@sandbox-workers/${language}/package.json`),
        "utf8",
      ),
    );
    assert.equal(pkg.dependencies, undefined);
    const config = JSON.parse(
      await readFile(join(worker, "wrangler.jsonc"), "utf8"),
    );
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    // Sessions (a Durable Object-backed REPL) are supported for python and
    // perl but not ruby; see docs/sessions-design.md.
    const indexSource = await readFile(join(worker, "index.js"), "utf8");
    if (language === "ruby") {
      assert.equal(config.durable_objects, undefined);
      assert.equal(config.migrations, undefined);
      assert.doesNotMatch(indexSource, /SandboxSession/);
    } else {
      assert.deepEqual(config.durable_objects, {
        bindings: [{ name: "SESSIONS", class_name: "SandboxSession" }],
      });
      assert.deepEqual(config.migrations, [
        { tag: "v1", new_sqlite_classes: ["SandboxSession"] },
      ]);
      assert.match(indexSource, /SandboxSession/);
    }
    const output = run(
      [
        join(worker, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--dry-run",
        "--outdir",
        "bundled",
      ],
      worker,
    );
    assert.match(output, /Total Upload:/);
    console.log(language, output.match(/Total Upload:.*/)[0]);
  } catch (error) {
    console.error(error.stdout?.toString(), error.stderr?.toString());
    throw error;
  }
}
console.log("Independent runtime tarballs verified in " + dir);
