import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
for (const language of ["javascript", "python", "perl", "ruby"]) {
  await mkdir(`packages/${language}/dist`, { recursive: true });
  await build({
    entryPoints: [
      `packages/${language}/src/worker.ts`,
      `packages/${language}/src/metadata.ts`,
    ],
    outdir: `packages/${language}/dist`,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["*.wasm", "*.bin"],
    // "neutral" has no default mainFields, so plain CommonJS dependencies
    // without an "exports" map (e.g. sucrase and its own dependencies)
    // would otherwise fail to resolve.
    mainFields: ["module", "main"],
  });
  await writeFile(
    `packages/${language}/dist/worker.d.ts`,
    "declare const worker: { fetch(request: Request): Promise<Response> };\nexport default worker;\n",
  );
  await writeFile(
    `packages/${language}/dist/metadata.d.ts`,
    `export declare const ${language}Runtime: { readonly id: "${language}"; readonly name: string; readonly package: string; readonly version: string; readonly engine: string; readonly enabled: true; readonly mode: string; readonly capabilities: readonly string[]; readonly limits: { readonly codeBytes: number; readonly requestBytes: number; readonly fuel: number; readonly memoryBytes: number } };\n`,
  );
}
