#!/usr/bin/env node
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const [command, runtimeArg, ...rest] = process.argv.slice(2);
const supportedRuntimes = ["javascript", "python", "perl", "ruby"];
// <runtime> is a comma-separated list, order preserved, no duplicates, every
// entry one of supportedRuntimes, at least one entry required.
const runtimeList = (runtimeArg ?? "").split(",");
const validRuntimeList =
  runtimeArg !== undefined &&
  runtimeList.length > 0 &&
  runtimeList.every((r) => supportedRuntimes.includes(r)) &&
  new Set(runtimeList).size === runtimeList.length;
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
if (command !== "init" || !validRuntimeList || invalidArgs) {
  console.log(
    "Usage: sandbox-workers init <javascript|python|perl|ruby>[,<javascript|python|perl|ruby>...] [directory] [--stateless]\nCreates a private Worker project, one Worker per runtime. Review each runtime's LICENSE and THIRD_PARTY_NOTICES.md before use or redistribution.",
  );
  process.exit(command === "--help" ? 0 : 1);
}
const directory = resolve(directoryArg ?? "sandbox-runtimes");
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
// Code contexts (an Interpreter Durable Object backing memory snapshots) are
// not supported for Ruby: its initial memory and RubyVM's host-side state
// rule out the memory-snapshot mechanism the other languages use (see
// docs/sessions-design.md). --stateless opts any runtime out the same way,
// producing a code-execution-only Worker (see docs/sandbox-1-0-design.md,
// "Ruby" / stateless deployments). --stateless applies to every runtime in
// the list.
const supportsContexts = (runtime) => runtime !== "ruby" && !stateless;
const contextRuntimes = runtimeList.filter(supportsContexts);
const statelessRuntimes = runtimeList.filter((r) => !supportsContexts(r));
const anyContexts = contextRuntimes.length > 0;

function servicesJsonc(indent) {
  return runtimeList
    .map(
      (r) =>
        `${indent}{ "binding": "${r.toUpperCase()}", "service": "sandbox-${r}" }`,
    )
    .join(",\n");
}

function buildReadme() {
  const title = `# sandbox runtime Workers: ${runtimeList.join(", ")}`;
  const intro =
    `Run \`pnpm install\`, \`pnpm dry-run\`, then \`pnpm run deploy\`. Each \`wrangler.<runtime>.jsonc\` deploys one private Worker (set a unique name first if the default collides in your account):\n\n` +
    runtimeList
      .map((r) => `- \`wrangler.${r}.jsonc\` deploys \`sandbox-${r}\``)
      .join("\n") +
    `\n\nBind each as a Service Binding in your own Worker (the caller).\n`;

  let connect;
  if (!anyContexts) {
    connect =
      `## Connect your application\n\n` +
      `Code contexts (durable, stateful REPLs) are not supported by any runtime here${
        stateless ? " (--stateless was used)" : ""
      }; every Worker in this project only serves stateless execution. Bind each as a Service Binding and call it with the free \`runCode\` function:\n\n` +
      `\`\`\`jsonc\n// your wrangler.jsonc\n{\n  "services": [\n${servicesJsonc("    ")}\n  ]\n}\n\`\`\`\n\n` +
      `\`\`\`ts\nimport { runCode } from "@sandbox-workers/core";\n\n` +
      runtimeList
        .map(
          (r) =>
            `const ${r} = await runCode(env.${r.toUpperCase()}, "1 + 1"); // ${r.toUpperCase()}: this Worker only serves stateless execution`,
        )
        .join("\n") +
      `\n\`\`\`\n`;
  } else {
    const envFields = runtimeList
      .map((r) => `  ${r.toUpperCase()}: Fetcher;`)
      .join("\n");
    let body =
      `## Connect your application\n\n` +
      `Each context-capable runtime's \`wrangler.<runtime>.jsonc\` already includes an \`INTERPRETER\` Durable Object binding (\`Interpreter\`, with a \`new_sqlite_classes\` migration), so your own Worker (the caller) can host a \`Sandbox\` Durable Object (from \`@sandbox-workers/core\`) and open code contexts bound to those Workers by name:\n\n` +
      `\`\`\`jsonc\n// your wrangler.jsonc\n{\n  "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },\n  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],\n  "services": [\n${servicesJsonc("    ")}\n  ]\n}\n\`\`\`\n\n` +
      `\`\`\`ts\n// your Worker's entry\nexport { Sandbox } from "@sandbox-workers/core";\n\`\`\`\n\n` +
      `\`\`\`ts\nimport { getSandbox${statelessRuntimes.length > 0 ? ", runCode" : ""} } from "@sandbox-workers/core";\n\ninterface Env {\n  Sandbox: DurableObjectNamespace;\n${envFields}\n}\n\n` +
      `const sandbox = getSandbox<Env>(env.Sandbox, "user-42");\n` +
      contextRuntimes
        .map(
          (r) =>
            `const ${r} = await sandbox.interpreter.createCodeContext({ binding: "${r.toUpperCase()}" });`,
        )
        .join("\n") +
      "\n";

    const contextSet = new Set(contextRuntimes);
    if (contextSet.has("python") && contextSet.has("javascript")) {
      // Mirrors website/content/stateful/get-started.md exactly: Python
      // writes /workspace/result.json, JavaScript reads it back, showing
      // that /workspace is shared across every context in the sandbox.
      body +=
        `\nconst squared = await sandbox.interpreter.runCode(\n` +
        `  "print('Hello!')\\nimport os\\nsquared = int(os.environ['X']) ** 2\\nsquared",\n` +
        `  { context: python, envVars: { X: "12" } },\n` +
        `);\n` +
        `await sandbox.interpreter.runCode(\n` +
        `  "import json\\nopen('/workspace/result.json', 'w').write(json.dumps({'squared': squared}))",\n` +
        `  { context: python },\n` +
        `);\n` +
        `const fromFile = await sandbox.interpreter.runCode(\n` +
        `  "fs.readFileSync('/workspace/result.json', 'utf8')",\n` +
        `  { context: javascript },\n` +
        `);\n`;
      const others = contextRuntimes.filter(
        (r) => r !== "python" && r !== "javascript",
      );
      if (others.length > 0)
        body +=
          "\n" +
          others
            .map(
              (r) =>
                `await sandbox.interpreter.runCode(code, { context: ${r} }); // runs against the ${r} runtime Worker`,
            )
            .join("\n") +
          "\n";
    } else if (contextRuntimes.length >= 2) {
      body +=
        "\n" +
        contextRuntimes
          .map(
            (r) =>
              `await sandbox.interpreter.runCode(code, { context: ${r} }); // runs against the ${r} runtime Worker`,
          )
          .join("\n") +
        "\n";
    } else if (contextRuntimes.length === 1) {
      const r = contextRuntimes[0];
      body +=
        `\n// A code context is a durable REPL: state survives across calls.\n` +
        `await sandbox.interpreter.runCode("x = 1", { context: ${r} });\n` +
        `const result = await sandbox.interpreter.runCode("x + 1", { context: ${r} }); // results: [{ text: "2" }]\n`;
    }

    if (statelessRuntimes.length > 0) {
      body +=
        "\n" +
        statelessRuntimes
          .map(
            (r) =>
              `const ${r} = await runCode(env.${r.toUpperCase()}, "1 + 1"); // ${r.toUpperCase()}: this Worker only serves stateless execution`,
          )
          .join("\n") +
        "\n";
    }
    body += "```\n\n";

    body +=
      `A code context keeps top-level variables and functions alive across calls, surviving Durable Object eviction, hibernation, and redeploys via a linear-memory snapshot taken after each execution; \`/workspace\` is shared by every context in the sandbox, including contexts bound to other runtime Workers. See [the code contexts guide](https://github.com/syumai/sandbox-workers/blob/main/website/content/stateful/code-contexts.md).\n\n` +
      `An idle sandbox is deleted automatically by your caller's own \`Sandbox\` Durable Object, based on \`SANDBOX_IDLE_TTL_MS\` (milliseconds, as a string) under \`vars\` in *your* \`wrangler.jsonc\` -- it defaults to 24 hours if unset, and \`"0"\` disables expiry. Each context-capable runtime Worker's own \`Interpreter\` Durable Object (holding its contexts' memory snapshots) expires independently via \`INTERPRETER_IDLE_TTL_MS\` under \`vars\` in *its own* \`wrangler.<runtime>.jsonc\`, same defaults; set it to at least \`SANDBOX_IDLE_TTL_MS\`, or a context's globals can already be gone (\`ContextNotFoundError\`) while the sandbox still lists it. For example:\n\n` +
      `\`\`\`jsonc\n// wrangler.${contextRuntimes[0]}.jsonc\n{\n  "vars": { "INTERPRETER_IDLE_TTL_MS": "3600000" } // 1 hour; "0" disables expiry\n}\n\`\`\`\n`;
    connect = body;
  }

  const licenses =
    `## Licenses\n\n` +
    `Before use or redistribution, review each runtime's license:\n\n` +
    runtimeList
      .map(
        (r) =>
          `- [${r} LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/${r}/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/${r}/THIRD_PARTY_NOTICES.md)`,
      )
      .join("\n") +
    `\n\nInstalled copies are in \`node_modules/@sandbox-workers/<runtime>/\` for each runtime. Bundled engines retain their upstream licenses; sandbox-workers' MIT license does not replace them.\n`;

  return `${title}\n\n${intro}\n${connect}\n${licenses}`;
}

const files = {};
for (const runtime of runtimeList) {
  const contextsSupported = supportsContexts(runtime);
  files[`${runtime}.js`] = contextsSupported
    ? `export { default, Interpreter } from "@sandbox-workers/${runtime}";\n`
    : `export { default } from "@sandbox-workers/${runtime}";\n`;
  files[`wrangler.${runtime}.jsonc`] =
    JSON.stringify(
      {
        $schema: "./node_modules/wrangler/config-schema.json",
        name: `sandbox-${runtime}`,
        main: `${runtime}.js`,
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
    ) + "\n";
}
files["package.json"] =
  JSON.stringify(
    {
      name: "sandbox-runtimes",
      private: true,
      type: "module",
      scripts: {
        dev: `wrangler dev ${runtimeList
          .map((r) => `-c wrangler.${r}.jsonc`)
          .join(" ")}`,
        deploy: runtimeList
          .map((r) => `wrangler deploy -c wrangler.${r}.jsonc`)
          .join(" && "),
        "dry-run": runtimeList
          .map(
            (r) =>
              `wrangler deploy --dry-run -c wrangler.${r}.jsonc --outdir dist/${r}`,
          )
          .join(" && "),
      },
      dependencies: Object.fromEntries(
        runtimeList.map((r) => [`@sandbox-workers/${r}`, version]),
      ),
      devDependencies: { wrangler: "^4.129.0" },
    },
    null,
    2,
  ) + "\n";
files["README.md"] = buildReadme();
files[".gitignore"] = "node_modules/\n.wrangler/\n.dev.vars\ndist/\n";

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
  `Created ${directory}\n\n` +
    `Next: cd into the directory, run pnpm install, then pnpm dry-run and pnpm run deploy.\n` +
    `Choose unique Worker names in the wrangler.<runtime>.jsonc files before deploying.\n` +
    `For Paid plans, optionally add limits.cpu_ms = 1000 to each wrangler.<runtime>.jsonc.\n` +
    `Bind your caller to: ${runtimeList
      .map((r) => `sandbox-${r} (${r.toUpperCase()})`)
      .join(", ")}. No public route is created.\n` +
    `Before use or redistribution, review each runtime's LICENSE and THIRD_PARTY_NOTICES.md under node_modules/@sandbox-workers/<runtime>/, including bundled engine licenses.`,
);
