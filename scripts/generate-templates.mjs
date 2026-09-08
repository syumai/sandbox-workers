import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
const commit = "b57abc48ad66eb5024b00271812a4aecc565e400";
const sha256 =
  "4bc402aa37e01c9465c20696323c644d51138912cd9aeb98b4bd4e0e32e59775";
for (const language of ["javascript", "python", "perl", "ruby"]) {
  const directory = `templates/${language}`;
  await mkdir(directory, { recursive: true });
  // Code contexts (an Interpreter Durable Object backing memory snapshots)
  // are not supported for Ruby; see docs/sandbox-1-0-design.md.
  const contextsSupported = language !== "ruby";
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
    limits: { cpu_ms: 2000 },
    build: { command: "pnpm run build" },
    rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
    ...(contextsSupported
      ? {
          durable_objects: {
            bindings: [{ name: "INTERPRETER", class_name: "Interpreter" }],
          },
          migrations: [{ tag: "v1", new_sqlite_classes: ["Interpreter"] }],
        }
      : {}),
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
  const readme = await readFile("scripts/template-readme.md", "utf8");
  await write(
    "README.md",
    renderTemplate(readme, language, contextsSupported),
  );
}
// Minimal templating: {{language}}/{{BINDING}} substitution and
// {{#sessions}}...{{/sessions}} / {{^sessions}}...{{/sessions}} blocks kept
// or dropped for the language.
function renderTemplate(text, language, sessionsSupported) {
  return text
    .replace(/{{#sessions}}\n([\s\S]*?){{\/sessions}}\n/g, (_, block) =>
      sessionsSupported ? block : "",
    )
    .replace(/{{\^sessions}}\n([\s\S]*?){{\/sessions}}\n/g, (_, block) =>
      sessionsSupported ? "" : block,
    )
    .replaceAll("{{BINDING}}", language.toUpperCase())
    .replaceAll("{{language}}", language);
}
