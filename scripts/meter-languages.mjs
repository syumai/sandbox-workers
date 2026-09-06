import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { instrument } from "./instrument.mjs";

// engine-build.json is each session-capable worker.ts's engine identity: the
// sha256 of its own metered dist/engine.wasm, used as `meta.build`/
// `snapshot.build` by the Durable Object (runtime/sandbox.mjs) to decide
// whether a stored snapshot still matches the running engine. Written next
// to worker.ts (packages/<language>/src) rather than dist/ so the plain
// relative `import build from "./engine-build.json"` in worker.ts resolves
// at bundle time (see scripts/build-packages.mjs, which esbuild-inlines it
// into dist/worker.js like any other JSON import).
async function writeEngineBuild(language) {
  const wasmPath = `packages/${language}/dist/engine.wasm`;
  const bytes = await readFile(wasmPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(`packages/${language}/src`, { recursive: true });
  await writeFile(
    `packages/${language}/src/engine-build.json`,
    JSON.stringify({ sha256, bytes: bytes.length }) + "\n",
  );
  console.log(`Wrote packages/${language}/src/engine-build.json (${sha256.slice(0, 12)}…, ${bytes.length} bytes)`);
}

const args = process.argv.slice(2);
const hashOnly = args.includes("--hash-only");
const languages = args.filter((a) => a !== "--hash-only");

for (const language of languages) {
  if (!["javascript", "python", "perl", "ruby"].includes(language))
    throw new Error("Unsupported runtime: " + language);
  if (hashOnly) {
    // Standalone mode: hash an already-built packages/<language>/dist/engine.wasm
    // without re-running the (multi-minute) instrument() step. Useful when only
    // runtime/packaging code changed, not the engine itself.
    await stat(`packages/${language}/dist/engine.wasm`).catch(() => {
      throw new Error(
        `packages/${language}/dist/engine.wasm does not exist; run the full build:languages first`,
      );
    });
  } else {
    const path =
      language === "ruby"
        ? "node_modules/@ruby/4.0-wasm-wasi/dist/ruby+stdlib.wasm"
        : `engine/.build/languages/${language}.wasm`;
    console.log("Instrumenting", language);
    await instrument(
      path,
      `packages/${language}/dist/engine.wasm`,
      language === "ruby" ? 1536 : 1024,
    );
  }
  await writeEngineBuild(language);
}
