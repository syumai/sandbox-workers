import { execFileSync } from "node:child_process";
for (const language of ["javascript", "python", "perl", "ruby"]) {
  const config =
    language === "javascript"
      ? "engine/wrangler.jsonc"
      : `engine/wrangler-${language}.jsonc`;
  execFileSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "-c",
      config,
      "--dry-run",
      "--outdir",
      `dist/deploy-${language}`,
    ],
    { stdio: "inherit" },
  );
}
execFileSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "deploy",
    "--dry-run",
    "--outdir",
    "dist/gateway",
  ],
  { stdio: "inherit" },
);
