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
  // JavaScript supports durable sandboxes (a Durable Object-backed code
  // interpreter); see docs/sdk-parity-design.md.
  assert.deepEqual(config.durable_objects, {
    bindings: [{ name: "SANDBOX", class_name: "Sandbox" }],
  });
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["Sandbox"] },
  ]);
  const indexSource = await readFile(join(worker, "index.js"), "utf8");
  assert.equal(
    indexSource,
    'export { default, Sandbox } from "@sandbox-workers/javascript";\n',
  );
  assert.match(indexSource, /Sandbox/);
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
  const clientTest = `import { getSandbox, SandboxError, FileNotFoundError, ContextNotFoundError } from '@sandbox-workers/core';
import assert from 'node:assert/strict';

// getSandbox() validates the id synchronously, before any request is made.
assert.throws(() => getSandbox({ async fetch() { throw new Error('should not be called'); } }, 'bad id!'), /Invalid sandbox id/);

const now = new Date().toISOString();
const calls = [];
function route(request) {
  const url = new URL(request.url);
  calls.push(request.method + ' ' + url.pathname);
  return { method: request.method, pathname: url.pathname };
}

const fetcher = {
  async fetch(request) {
    const { method, pathname } = route(request);
    if (pathname === '/sandboxes/demo/contexts' && method === 'POST')
      return Response.json({ id: 'ctx-1', language: 'javascript', cwd: '/workspace', createdAt: now, lastUsed: now }, { status: 201 });
    if (pathname === '/sandboxes/demo/contexts' && method === 'GET')
      return Response.json({ contexts: [{ id: 'ctx-1', language: 'javascript', cwd: '/workspace', createdAt: now, lastUsed: now }] });
    if (pathname === '/sandboxes/demo/contexts/ctx-1' && method === 'DELETE')
      return Response.json({ success: true });
    if (pathname === '/sandboxes/demo/execute' && method === 'POST') {
      const body = JSON.parse(await request.text());
      assert.equal(body.contextId, 'ctx-1');
      assert.deepEqual(body.envVars, { CALL: 'x' });
      assert.equal('language' in body, false);
      return Response.json({
        code: body.code,
        logs: { stdout: [], stderr: [] },
        results: [{ text: '2' }],
        language: 'javascript',
        engine: 'x',
        durationMs: 1,
        executionCount: 1,
        context: { id: 'ctx-1', cwd: '/workspace', executions: 1 },
      });
    }
    if (pathname === '/sandboxes/demo/files' && method === 'POST') {
      const body = JSON.parse(await request.text());
      if (body.op === 'read')
        return Response.json({
          code: 'FILE_NOT_FOUND',
          message: 'no such file',
          context: { path: '/workspace/missing.txt', operation: 'file.read', errno: 'ENOENT' },
          httpStatus: 404,
          timestamp: now,
        }, { status: 404 });
      if (body.op === 'write')
        return Response.json({ success: true, path: '/workspace/a.txt', timestamp: now });
      throw new Error('unexpected files op ' + body.op);
    }
    if (pathname === '/sandboxes/demo/env' && method === 'POST')
      return Response.json({ success: true });
    if (pathname === '/sandboxes/demo' && method === 'GET')
      return Response.json({
        id: 'demo',
        language: 'javascript',
        engine: 'x',
        createdAt: now,
        lastUsed: now,
        envVars: {},
        contexts: [],
        workspace: { files: 0, bytes: 0 },
        expiresAt: null,
      });
    if (pathname === '/sandboxes/demo' && method === 'DELETE')
      return Response.json({ success: true });
    throw new Error('unexpected request ' + method + ' ' + pathname);
  },
};
const sandbox = getSandbox(fetcher, 'demo');

const ctx = await sandbox.createCodeContext();
assert.ok(ctx.createdAt instanceof Date);
assert.ok(ctx.lastUsed instanceof Date);

const contexts = await sandbox.listCodeContexts();
assert.equal(contexts.length, 1);
assert.ok(contexts[0].createdAt instanceof Date);

const executed = await sandbox.runCode('1 + 1', { context: ctx, envVars: { CALL: 'x' } });
assert.deepEqual(executed.results, [{ text: '2' }]);
assert.equal(executed.context.id, 'ctx-1');

await sandbox.writeFile('/workspace/a.txt', 'hi');
await assert.rejects(sandbox.readFile('/workspace/missing.txt'), (error) => {
  assert.ok(error instanceof FileNotFoundError);
  assert.equal(error.code, 'FILE_NOT_FOUND');
  assert.equal(error.httpStatus, 404);
  assert.equal(error.context.errno, 'ENOENT');
  return true;
});

await sandbox.setEnvVars({ TOKEN: 'abc' });
const info = await sandbox.getInfo();
assert.equal(info.id, 'demo');
await sandbox.deleteCodeContext('ctx-1');
await sandbox.destroy();

assert.deepEqual(calls, [
  'POST /sandboxes/demo/contexts',
  'GET /sandboxes/demo/contexts',
  'POST /sandboxes/demo/execute',
  'POST /sandboxes/demo/files',
  'POST /sandboxes/demo/files',
  'POST /sandboxes/demo/env',
  'GET /sandboxes/demo',
  'DELETE /sandboxes/demo/contexts/ctx-1',
  'DELETE /sandboxes/demo',
]);

// A non-JSON error response (e.g. a raw 503 from an unhealthy Worker) maps
// to a generic SandboxError, not a thrown parse error.
const broken = getSandbox({ async fetch() { return new Response('down', { status: 503 }); } }, 'demo');
await assert.rejects(broken.runCode('1'), (error) => {
  assert.ok(error instanceof SandboxError);
  assert.equal(error.code, 'INTERNAL_ERROR');
  return true;
});

// Durable Object namespace transport: idFromName is used to resolve the
// stub, the id travels as the x-sandbox-id header (not in the path), and
// the forwarded path has no /sandboxes/<id> prefix.
const namespaceCalls = [];
const namespace = {
  idFromName(name) {
    return 'id:' + name;
  },
  get(id) {
    return {
      async fetch(request) {
        const url = new URL(request.url);
        namespaceCalls.push({ id, headers: Object.fromEntries(request.headers), pathname: url.pathname });
        return Response.json({ success: true, path: '/workspace/a.txt', exists: true, timestamp: now });
      },
    };
  },
};
const nsSandbox = getSandbox(namespace, 'demo');
await nsSandbox.exists('/workspace/a.txt');
assert.equal(namespaceCalls[0].id, 'id:demo');
assert.equal(namespaceCalls[0].headers['x-sandbox-id'], 'demo');
assert.equal(namespaceCalls[0].pathname.includes('/sandboxes/'), false);

// ContextNotFoundError is importable and part of the error hierarchy, even
// though this smoke test doesn't need to trigger it over the wire.
assert.equal(ContextNotFoundError.name, 'ContextNotFoundError');
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
