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
  });
  const supportsSessions = language !== "ruby";
  await writeFile(
    `packages/${language}/dist/worker.d.ts`,
    supportsSessions
      ? [
          "declare const worker: { fetch(request: Request): Promise<Response> };",
          "export default worker;",
          "// Bind this in the consuming Worker's wrangler config as SESSIONS to use",
          "// sessions: { durable_objects: { bindings: [{ name: \"SESSIONS\", class_name: \"SandboxSession\" }] } }.",
          "export interface Env {",
          "  SESSIONS: DurableObjectNamespace;",
          "}",
          "export declare class SandboxSession {",
          "  constructor(ctx: DurableObjectState, env: unknown);",
          "  fetch(request: Request): Promise<Response>;",
          "}",
          "",
        ].join("\n")
      : [
          "declare const worker: { fetch(request: Request): Promise<Response> };",
          "export default worker;",
          "// Sessions are not supported for ruby: POST /sessions/* answers 400.",
          "",
        ].join("\n"),
  );
  await writeFile(
    `packages/${language}/dist/metadata.d.ts`,
    `export declare const ${language}Runtime: { readonly id: "${language}"; readonly name: string; readonly package: string; readonly version: string; readonly engine: string; readonly enabled: true; readonly mode: string; readonly capabilities: readonly string[]; readonly limits: { readonly codeBytes: number; readonly requestBytes: number; readonly fuel: number; readonly memoryBytes: number } };\n`,
  );
}
