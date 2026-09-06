#!/usr/bin/env node
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const [command, runtime, ...rest] = process.argv.slice(2);
const runtimes = ["javascript", "python", "perl", "ruby"];
// --stateless may appear before or after the directory argument; anything
// else unrecognized (an extra positional, an unknown flag) is rejected.
let directoryArg;
let stateless = false;
let invalidArgs = false;
for (const arg of rest) {
  if (arg === "--stateless") stateless = true;
  else if (directoryArg === undefined && !arg.startsWith("-")) directoryArg = arg;
  else invalidArgs = true;
}
if (command !== "init" || !runtimes.includes(runtime) || invalidArgs) {
  console.log(
    "Usage: sandbox-workers init <javascript|python|perl|ruby> [directory] [--stateless]\nCreates a private Worker project. Review the runtime LICENSE and THIRD_PARTY_NOTICES.md before use or redistribution.",
  );
  process.exit(command === "--help" ? 0 : 1);
}
const directory = resolve(directoryArg ?? `sandbox-${runtime}`);
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const binding = runtime.toUpperCase();
// Code contexts (an Interpreter Durable Object backing memory snapshots) are
// not supported for Ruby: its initial memory and RubyVM's host-side state
// rule out the memory-snapshot mechanism the other languages use (see
// docs/sessions-design.md). --stateless opts any runtime out the same way,
// producing a code-execution-only Worker (see docs/sandbox-1-0-design.md,
// "Ruby" / stateless deployments).
const contextsSupported = runtime !== "ruby" && !stateless;
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
  "index.js": contextsSupported
    ? `export { default, Interpreter } from "@sandbox-workers/${runtime}";\n`
    : `export { default } from "@sandbox-workers/${runtime}";\n`,
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
        ...(contextsSupported
          ? {
              durable_objects: {
                bindings: [
                  { name: "INTERPRETER", class_name: "Interpreter" },
                ],
              },
              migrations: [
                { tag: "v1", new_sqlite_classes: ["Interpreter"] },
              ],
            }
          : {}),
      },
      null,
      2,
    ) + "\n",
  "README.md": `# ${runtime} sandbox Worker\n\nRun pnpm install, pnpm dry-run, then pnpm run deploy. Set a unique Worker name first. Bind it as a Service Binding in your own Worker (the caller).\n${
    contextsSupported
      ? `\n## Connect your application\n\nThis Worker's \`wrangler.jsonc\` already includes an \`INTERPRETER\` Durable Object binding (\`Interpreter\`, with a \`new_sqlite_classes\` migration), so your own Worker (the caller) can host a \`Sandbox\` Durable Object (from \`@sandbox-workers/core\`) and open code contexts bound to this Worker by name:\n\n\`\`\`jsonc\n// your wrangler.jsonc\n{\n  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },\n  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],\n  "services": [{ "binding": "${binding}", "service": "sandbox-${runtime}" }]\n}\n\`\`\`\n\n\`\`\`ts\n// your Worker's entry\nexport { Sandbox } from "@sandbox-workers/core";\n\`\`\`\n\n\`\`\`ts\nimport { getSandbox } from "@sandbox-workers/core";\n\nconst sandbox = getSandbox(env.Sandbox, "user-42");\nconst ctx = await sandbox.interpreter.createCodeContext({ binding: "${binding}" });\nawait sandbox.interpreter.runCode(code, { context: ctx });\n\`\`\`\n\nA code context keeps top-level variables and functions alive across calls, surviving Durable Object eviction, hibernation, and redeploys via a linear-memory snapshot taken after each execution; \`/workspace\` is shared by every context in the sandbox, including contexts bound to other runtime Workers. See [the code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/guides/code-contexts.md).\n\nAn idle sandbox is deleted automatically by your caller's own \`Sandbox\` Durable Object, based on \`SANDBOX_IDLE_TTL_MS\` (milliseconds, as a string) under \`vars\` in *your* \`wrangler.jsonc\` -- it defaults to 24 hours if unset, and \`"0"\` disables expiry. This Worker's own \`Interpreter\` Durable Object (holding each context's memory snapshot) expires independently via \`INTERPRETER_IDLE_TTL_MS\` under \`vars\` in *this* \`wrangler.jsonc\`, same defaults; set it to at least \`SANDBOX_IDLE_TTL_MS\`, or a context's globals can already be gone (\`ContextNotFoundError\`) while the sandbox still lists it. For example:\n\n\`\`\`jsonc\n// this Worker's wrangler.jsonc\n{\n  "vars": { "INTERPRETER_IDLE_TTL_MS": "3600000" } // 1 hour; "0" disables expiry\n}\n\`\`\`\n`
      : `\n## Connect your application\n\nCode contexts (durable, stateful REPLs) are not supported for ${runtime === "ruby" ? "ruby" : "a --stateless deployment"}; this Worker only serves stateless execution. Call it with the free \`runCode\` function:\n\n\`\`\`ts\nimport { runCode } from "@sandbox-workers/core";\nconst result = await runCode(env.SANDBOX, "1 + 1"); // SANDBOX: a Service Binding to this Worker\n\`\`\`\n`
  }\n## Licenses\n\nBefore use or redistribution, review [the runtime LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/${runtime}/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/${runtime}/THIRD_PARTY_NOTICES.md). Installed copies are in node_modules/@sandbox-workers/${runtime}/. Bundled engines retain their upstream licenses; sandbox-workers' MIT license does not replace them.\n`,
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
