import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
for (const name of [
  "worker.js",
  "worker.d.ts",
  "metadata.js",
  "metadata.d.ts",
  "engine.wasm",
])
  await stat(`dist/${name}`);
const module = new WebAssembly.Module(await readFile("dist/engine.wasm"));
if (
  !WebAssembly.Module.imports(module).some(
    (i) => i.module === "sandbox" && i.name === "tick",
  )
)
  throw new Error("Package contains an unmetered engine");
if (
  (await stat("dist/engine.wasm")).size +
    (await stat("dist/worker.js")).size +
    (await stat("dist/stdlib.bin")).size >=
  64 * 1024 * 1024
)
  throw new Error("Engine exceeds Worker size limit");

// src/engine-build.json is worker.ts's `import build from "./engine-build.json"`
// (see scripts/meter-languages.mjs) -- the sha256 SandboxSession uses as
// `meta.build`/`snapshot.build` to guard a restore. Required (not merely
// tolerated) here: without it, every session would restore from any prior
// snapshot regardless of which engine build produced it.
const engineBuild = JSON.parse(await readFile("src/engine-build.json", "utf8"));
const engineBytes = await readFile("dist/engine.wasm");
const expectedSha256 = createHash("sha256").update(engineBytes).digest("hex");
if (engineBuild.sha256 !== expectedSha256)
  throw new Error(
    "src/engine-build.json is stale (its sha256 doesn't match dist/engine.wasm) -- " +
      "rerun `node scripts/meter-languages.mjs --hash-only <language>`",
  );
// dist/worker.js is esbuild's bundle of worker.ts + the inlined JSON import
// (see scripts/build-packages.mjs; engine-build.json itself isn't shipped as
// a separate dist file). Confirm the bundle actually embeds the hash just
// verified above, catching a build:packages run against a since-changed
// engine-build.json.
const workerSource = await readFile("dist/worker.js", "utf8");
if (!workerSource.includes(expectedSha256))
  throw new Error("dist/worker.js does not embed the current engine build hash; rerun build:packages");
console.log("Runtime package verified");
