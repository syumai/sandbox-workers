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
if ((await stat("dist/engine.wasm")).size >= 64 * 1024 * 1024)
  throw new Error("Engine exceeds Worker size limit");
console.log("Runtime package verified");
