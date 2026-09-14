import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

// Re-pins templates/* to a commit: resolves <ref> to a full sha, downloads
// and hashes its tarball exactly as templates/*/build.mjs does, writes
// scripts/template-pin.json, then regenerates the templates from it.
//
// Usage: node scripts/pin-templates.mjs <ref>   (e.g. a tag like v0.2.0)

const ref = process.argv[2];
if (!ref) throw new Error("Usage: node scripts/pin-templates.mjs <ref>");

const commit = execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
  encoding: "utf8",
}).trim();

const url = `https://api.github.com/repos/syumai/sandbox-workers/tarball/${commit}`;
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const response = await fetch(url, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  signal: AbortSignal.timeout(120000),
});
if (!response.ok)
  throw new Error(`Cannot download ${url} (${response.status})`);
const archive = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(archive).digest("hex");

await writeFile(
  "scripts/template-pin.json",
  JSON.stringify({ commit, sha256 }, null, 2) + "\n",
);

execFileSync(process.execPath, ["scripts/generate-templates.mjs"], {
  stdio: "inherit",
});

console.log(`Pinned templates/* to commit ${commit}`);
console.log(`sha256 ${sha256}`);
