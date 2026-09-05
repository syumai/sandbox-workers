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
  // JavaScript supports sessions (a Durable Object-backed REPL); see
  // docs/sessions-design.md.
  assert.deepEqual(config.durable_objects, {
    bindings: [{ name: "SESSIONS", class_name: "SandboxSession" }],
  });
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["SandboxSession"] },
  ]);
  assert.match(
    await readFile(join(worker, "index.js"), "utf8"),
    /SandboxSession/,
  );
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
  const clientTest = `import { createSandbox, SandboxTransportError, SandboxFileError } from '@sandbox-workers/core';
import assert from 'node:assert/strict';
let body;
const client = createSandbox({ async fetch(request) { body = await request.json(); return Response.json({logs:{stdout:[],stderr:[]},results:[{text:'144'}]}); } });
assert.deepEqual(await client.runCode('process.env.X ** 2', { envVars: { X: '12' } }), {logs:{stdout:[],stderr:[]},results:[{text:'144'}]});
assert.equal(body.language,'javascript');
assert.equal(body.envVars.X,'12');
const broken = createSandbox({ async fetch() { return new Response('down',{status:503}); } });
await assert.rejects(broken.runCode('1'),SandboxTransportError);
// Session client: id validation, execute/info/reset/destroy routing, and file errors.
assert.throws(() => client.session('bad id!'), /Invalid session id/);
const calls = [];
const sessionBinding = createSandbox({
  async fetch(request) {
    const url = new URL(request.url);
    calls.push(request.method + ' ' + url.pathname);
    if (url.pathname.endsWith('/execute'))
      return Response.json({logs:{stdout:[],stderr:[]},results:[{text:'1'}],session:{id:'demo',cwd:'/workspace',executions:1}});
    if (request.method === 'DELETE' || url.pathname.endsWith('/reset'))
      return Response.json({ok:true});
    if (url.pathname.endsWith('/files')) {
      const req = await request.json();
      if (req.op === 'read')
        return Response.json({error:{name:'FileError',code:'ENOENT',message:'no such file'}}, {status:404});
      return Response.json({size:3});
    }
    return Response.json({id:'demo',language:'javascript',engine:'x',cwd:'/workspace',createdAt:0,lastUsed:0,executions:1,workspace:{files:0,bytes:0},snapshot:null});
  },
}, 'javascript').session('demo');
const executed = await sessionBinding.runCode('1', { cwd: '/workspace' });
assert.equal(executed.session.executions, 1);
const info = await sessionBinding.info();
assert.equal(info.id, 'demo');
await sessionBinding.reset();
await sessionBinding.destroy();
assert.deepEqual(await sessionBinding.writeFile('/workspace/a.txt', 'hi'), { size: 3 });
await assert.rejects(sessionBinding.readFile('/workspace/missing.txt'), (error) => {
  assert.ok(error instanceof SandboxFileError);
  assert.equal(error.code, 'ENOENT');
  assert.equal(error.status, 404);
  return true;
});
assert.deepEqual(calls, [
  'POST /sessions/demo/execute',
  'GET /sessions/demo',
  'POST /sessions/demo/reset',
  'DELETE /sessions/demo',
  'POST /sessions/demo/files',
  'POST /sessions/demo/files',
]);
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
