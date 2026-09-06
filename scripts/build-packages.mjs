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
    external: ["*.wasm", "*.bin", "cloudflare:*"],
    // "neutral" has no default mainFields, so plain CommonJS dependencies
    // without an "exports" map (e.g. sucrase and its own dependencies)
    // would otherwise fail to resolve.
    mainFields: ["module", "main"],
  });
  const supportsSandboxes = language !== "ruby";
  await writeFile(
    `packages/${language}/dist/worker.d.ts`,
    supportsSandboxes
      ? [
          "declare const worker: { fetch(request: Request): Promise<Response> };",
          "export default worker;",
          "// Bind this in the consuming Worker's wrangler config as SANDBOX to use",
          "// sandboxes: { durable_objects: { bindings: [{ name: \"SANDBOX\", class_name: \"Sandbox\" }] } }.",
          "// SANDBOX is optional: deployed without it, this Worker still serves plain",
          "// /execute and a context-less /sandboxes/:id/execute (stateless mode).",
          "export interface Env {",
          "  SANDBOX?: DurableObjectNamespace;",
          "}",
          "export declare class Sandbox {",
          "  constructor(ctx: DurableObjectState, env: unknown);",
          "  fetch(request: Request): Promise<Response>;",
          "}",
          "",
        ].join("\n")
      : [
          "declare const worker: { fetch(request: Request): Promise<Response> };",
          "export default worker;",
          "// Code contexts are not supported for ruby: /sandboxes/* routes other than",
          "// a context-less execute answer 400.",
          "",
        ].join("\n"),
  );
  await writeFile(
    `packages/${language}/dist/metadata.d.ts`,
    `export declare const ${language}Runtime: { readonly id: "${language}"; readonly name: string; readonly package: string; readonly version: string; readonly engine: string; readonly enabled: true; readonly mode: string; readonly capabilities: readonly string[]; readonly limits: { readonly codeBytes: number; readonly requestBytes: number; readonly fuel: number; readonly memoryBytes: number } };\n`,
  );
}
