import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(".");
const { version } = JSON.parse(
  await readFile("packages/javascript/package.json", "utf8"),
);
const js = join(root, `dist/sandbox-workers-javascript-${version}.tgz`);
const core = join(root, `dist/sandbox-workers-core-${version}.tgz`);
await access(js);
const cli = join(root, `dist/sandbox-workers-cli-${version}.tgz`);
await access(core);
await access(cli);
const dir = await mkdtemp(join(tmpdir(), "sandbox-workers-package-"));
const run = (cmd, args, cwd = dir) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120000,
  });
await writeFile(join(dir, "package.json"), '{"private":true,"type":"module"}');
try {
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    js,
    core,
    cli,
  ]);
  const pkg = JSON.parse(
    await readFile(
      join(dir, "node_modules/@sandbox-workers/javascript/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    pkg.dependencies,
    undefined,
    "runtime must not need build tools or workspace dependencies",
  );
  const init = join(dir, "node_modules/@sandbox-workers/cli/bin/cli.mjs");
  run(process.execPath, [init, "init", "javascript", "worker"]);
  assert.throws(
    () => run(process.execPath, [init, "init", "javascript", "worker"]),
    /Refusing to overwrite/,
  );
  const worker = join(dir, "worker");
  const config = JSON.parse(
    await readFile(join(worker, "wrangler.jsonc"), "utf8"),
  );
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", js],
    worker,
  );
  const output = run(
    process.execPath,
    [
      join(worker, "node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      "--outdir",
      "bundled",
    ],
    worker,
  );
  assert.match(output, /Total Upload:/);
  console.log(output);
  // Use only exports from the installed client tarball, not workspace sources.
  const clientTest = `import { createSandbox, SandboxTransportError } from '@sandbox-workers/core';
import assert from 'node:assert/strict';
let body;
const client = createSandbox({ async fetch(request) { body = await request.json(); return Response.json({ok:true,result:144}); } });
assert.deepEqual(await client.execute({code:'return input.x ** 2',input:{x:12}}),{ok:true,result:144});
assert.equal(body.language,'javascript');
assert.equal(body.input.x,12);
const broken = createSandbox({ async fetch() { return new Response('down',{status:503}); } });
await assert.rejects(broken.execute({code:'return 1'}),SandboxTransportError);
`;
  await writeFile(join(dir, "client-test.mjs"), clientTest);
  run(process.execPath, ["client-test.mjs"]);
  console.log(
    `Packed runtime, initializer overwrite protection, private config, isolated Wrangler build and client verified in ${dir}`,
  );
} catch (error) {
  if (error.stdout) console.error(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  throw error;
}
