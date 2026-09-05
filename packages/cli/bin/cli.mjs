#!/usr/bin/env node
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const [command, runtime, directoryArg, ...extra] = process.argv.slice(2);
const runtimes = ["javascript", "python", "perl", "ruby"];
if (
  command !== "init" ||
  !runtimes.includes(runtime) ||
  extra.length ||
  directoryArg?.startsWith("-")
) {
  console.log(
    "Usage: sandbox-workers init <javascript|python|perl|ruby> [directory]\nCreates a private Worker project. Review the runtime LICENSE and THIRD_PARTY_NOTICES.md before use or redistribution.",
  );
  process.exit(command === "--help" ? 0 : 1);
}
const directory = resolve(directoryArg ?? `sandbox-${runtime}`);
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const files = {
  "package.json":
    JSON.stringify(
      {
        name: `sandbox-${runtime}-worker`,
        private: true,
        type: "module",
        scripts: {
          dev: "wrangler dev",
          deploy: "wrangler deploy",
          "dry-run": "wrangler deploy --dry-run",
        },
        dependencies: { [`@sandbox-workers/${runtime}`]: version },
        devDependencies: { wrangler: "^4.129.0" },
      },
      null,
      2,
    ) + "\n",
  "index.js": `export { default } from "@sandbox-workers/${runtime}";\n`,
  "wrangler.jsonc":
    JSON.stringify(
      {
        $schema: "./node_modules/wrangler/config-schema.json",
        name: `sandbox-${runtime}`,
        main: "index.js",
        compatibility_date: "2026-09-04",
        workers_dev: false,
        preview_urls: false,
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      },
      null,
      2,
    ) + "\n",
  "README.md": `# ${runtime} sandbox Worker\n\nRun pnpm install, pnpm dry-run, then pnpm run deploy. Set a unique Worker name first. Bind your caller to that Worker name. Code is a function body with JSON input (input, or $input for Perl).\n\n## Licenses\n\nBefore use or redistribution, review [the runtime LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/${runtime}/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/${runtime}/THIRD_PARTY_NOTICES.md). Installed copies are in node_modules/@sandbox-workers/${runtime}/. Bundled engines retain their upstream licenses; sandbox-workers' MIT license does not replace them.\n`,
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
  `Created ${directory}\n\nNext: cd into the directory, run pnpm install, then pnpm dry-run and pnpm run deploy.\nChoose a unique Worker name in wrangler.jsonc before deploying.\nFor Paid plans, optionally add limits.cpu_ms = 1000.\nBind your caller to service "sandbox-${runtime}". No public route is created.\nBefore use or redistribution, review @sandbox-workers/${runtime}/LICENSE and THIRD_PARTY_NOTICES.md, including bundled engine licenses.`,
);
