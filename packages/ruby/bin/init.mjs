#!/usr/bin/env node
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] !== "init" || args.length > 2 || args[1]?.startsWith("-")) {
  console.log(
    "Usage: sandbox-workers-ruby init [directory]\nCreates a private Worker project. Then run npm install and npm run deploy in it.",
  );
  process.exit(args[0] === "--help" ? 0 : 1);
}
const directory = resolve(args[1] ?? "sandbox-ruby");
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const files = {
  "package.json":
    JSON.stringify(
      {
        name: "sandbox-ruby-worker",
        private: true,
        type: "module",
        scripts: {
          dev: "wrangler dev",
          deploy: "wrangler deploy",
          "dry-run": "wrangler deploy --dry-run",
        },
        dependencies: { "@sandbox-workers/ruby": version },
        devDependencies: { wrangler: "^4.129.0" },
      },
      null,
      2,
    ) + "\n",
  "index.js": 'export { default } from "@sandbox-workers/ruby";\n',
  "wrangler.jsonc":
    JSON.stringify(
      {
        $schema: "./node_modules/wrangler/config-schema.json",
        name: "sandbox-ruby",
        main: "index.js",
        compatibility_date: "2026-09-04",
        workers_dev: false,
        preview_urls: false,
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      },
      null,
      2,
    ) + "\n",
  ".gitignore": "node_modules/\n.wrangler/\n.dev.vars\n",
};
// Refuse existing files, including dangling symlinks, and never overwrite them.
await mkdir(directory, { recursive: true });
const { lstat } = await import("node:fs/promises");
for (const name of Object.keys(files)) {
  try {
    await lstat(join(directory, name));
    throw new Error(`Refusing to overwrite ${join(directory, name)}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
for (const [name, content] of Object.entries(files))
  await writeFile(join(directory, name), content, { flag: "wx" });
console.log(
  `Created ${directory}\n\nNext: cd into the directory, run npm install, then npm run dry-run and npm run deploy.\nChoose a unique Worker name in wrangler.jsonc before deploying.\nFor Paid plans, optionally add limits.cpu_ms = 1000.\nBind your caller to service "sandbox-ruby". No public route is created.`,
);
