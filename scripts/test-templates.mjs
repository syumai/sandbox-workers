import { cp, mkdtemp, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const dir = await mkdtemp(resolve(tmpdir(), "sandbox-deploy-templates-"));
console.log("Isolated validation directory:", dir);
for (const language of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["javascript", "python", "perl", "ruby"]) {
  const target = resolve(dir, language);
  await cp(resolve(root, "templates", language), target, { recursive: true });
  const run = (command, args) =>
    execFileSync(command, args, { cwd: target, stdio: "inherit" });
  run("pnpm", ["install", "--frozen-lockfile"]);
  run(process.execPath, [
    "build.mjs",
    ...(process.env.SANDBOX_SOURCE_ARCHIVE
      ? ["--source-archive", process.env.SANDBOX_SOURCE_ARCHIVE]
      : []),
  ]);
  const config = JSON.parse(
    await readFile(resolve(target, "wrangler.jsonc"), "utf8"),
  );
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  run("pnpm", ["run", "dry-run"]);
  console.log(language, "isolated build and dry-run passed");
}
