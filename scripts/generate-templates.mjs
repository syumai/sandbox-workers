import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
const commit = "f68d0f36c26731c6a0d8d76a2c394084fef116b0";
const sha256 =
  "8d694dc8f51137de11bc94a0c7840c4731605741a6a4871713dd97b11208c30a";
for (const language of ["javascript", "python", "perl", "ruby"]) {
  const directory = `templates/${language}`;
  await mkdir(directory, { recursive: true });
  const write = (name, value) =>
    writeFile(
      `${directory}/${name}`,
      typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    );
  await write("package.json", {
    name: `sandbox-${language}-worker`,
    private: true,
    type: "module",
    license: "MIT",
    packageManager: "pnpm@10.7.1",
    scripts: {
      build: "node build.mjs",
      dev: "wrangler dev",
      deploy: "wrangler deploy",
      "dry-run": "wrangler deploy --dry-run",
    },
    devDependencies: { wrangler: "4.129.0" },
    engines: { node: ">=22.12" },
  });
  await write("wrangler.jsonc", {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: `sandbox-${language}`,
    main: "runtime/worker.js",
    compatibility_date: "2026-09-04",
    workers_dev: false,
    preview_urls: false,
    limits: { cpu_ms: language === "javascript" ? 1000 : 2000 },
    build: { command: "pnpm run build" },
    rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
  });
  await write("runtime-source.json", {
    language,
    commit,
    url: `https://api.github.com/repos/syumai/sandbox-workers/tarball/${commit}`,
    sha256,
  });
  await write(
    ".gitignore",
    "node_modules/\n.runtime-build/\nruntime/\n.wrangler/\n.dev.vars\n",
  );
  await write(".node-version", "24\n");
  await copyFile("scripts/template-build.mjs", `${directory}/build.mjs`);
  await copyFile("LICENSE", `${directory}/LICENSE`);
  await write(
    "README.md",
    (await readFile("scripts/template-readme.md", "utf8")).replaceAll(
      "{{language}}",
      language,
    ),
  );
}
