import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  await readFile(resolve(root, "runtime-source.json"), "utf8"),
);
if (!["javascript", "python", "perl", "ruby"].includes(spec.language))
  throw new Error("Invalid runtime language");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const cacheKey = hash(JSON.stringify(spec));
const output = resolve(root, "runtime");
try {
  const manifest = JSON.parse(
    await readFile(resolve(output, "build-manifest.json"), "utf8"),
  );
  if (manifest.cacheKey === cacheKey) {
    const valid = await Promise.all(
      Object.entries(manifest.files).map(
        async ([file, digest]) =>
          hash(await readFile(resolve(output, file))) === digest,
      ),
    );
    if (valid.every(Boolean)) {
      console.log(`Verified cached ${spec.language} runtime`);
      process.exit(0);
    }
  }
} catch {
  /* No verified build yet. */
}
const work = resolve(root, ".runtime-build");
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
// --source-archive supports offline validation with the same pinned digest.
const archiveArg = process.argv.indexOf("--source-archive");
let archive;
if (archiveArg !== -1) {
  if (!process.argv[archiveArg + 1])
    throw new Error("--source-archive requires a path");
  archive = await readFile(resolve(process.argv[archiveArg + 1]));
} else {
  const response = await fetch(spec.url, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(
      `Cannot download runtime source (${response.status}). The source repository must be public.`,
    );
  archive = Buffer.from(await response.arrayBuffer());
}
if (hash(archive) !== spec.sha256)
  throw new Error("Runtime source checksum mismatch");
const archivePath = resolve(work, "source.tar.gz");
await writeFile(archivePath, archive);
const source = resolve(work, "source");
await mkdir(source);
execFileSync(
  "tar",
  ["-xzf", archivePath, "--strip-components=1", "-C", source],
  { stdio: "inherit" },
);
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: source,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
run("npm", ["ci", "--no-audit", "--no-fund"]);
await mkdir(resolve(source, "engine/.build"), { recursive: true });
if (spec.language === "javascript") run("npm", ["run", "build:engine"]);
else {
  run(process.execPath, ["scripts/fetch-languages.mjs"]);
  run(process.execPath, ["scripts/meter-languages.mjs", spec.language]);
}
run("npm", ["run", "build:packages"]);
const packageRoot = resolve(source, "packages", spec.language);
await rm(output, { recursive: true, force: true });
await cp(resolve(packageRoot, "dist"), output, { recursive: true });
await cp(resolve(packageRoot, "licenses"), resolve(output, "licenses"), {
  recursive: true,
});
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
  await cp(resolve(packageRoot, file), resolve(output, file));
const files = {};
for (const file of [
  "worker.js",
  "engine.wasm",
  ...(spec.language === "python" || spec.language === "perl"
    ? ["stdlib.bin"]
    : []),
])
  files[file] = hash(await readFile(resolve(output, file)));
await writeFile(
  resolve(output, "build-manifest.json"),
  JSON.stringify({ cacheKey, source: spec, files }, null, 2) + "\n",
);
console.log(`Built ${spec.language} from ${spec.commit}`);
