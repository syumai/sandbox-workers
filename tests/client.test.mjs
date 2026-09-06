// Pure Node tests for the SDK-parity typed client (see
// docs/sdk-parity-design.md). Run `pnpm --filter @sandbox-workers/core
// build` first; this imports the built package, not the TypeScript source.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSandbox,
  errorResponse,
  errnoErrorResponse,
  createErrorFromResponse,
  ApiError,
  SandboxError,
  FileNotFoundError,
  FileExistsError,
  FileTooLargeError,
  PermissionDeniedError,
  FileSystemError,
  ContextNotFoundError,
  ValidationFailedError,
  CodeExecutionError,
  ErrorCode,
} from "../packages/core/dist/index.js";

// ---- helpers ---------------------------------------------------------------

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "content-type": "application/json" },
  });
}

/** A fake Service Binding (Fetcher-shaped: no idFromName/get). */
function makeFetcher(handler) {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      const body =
        request.method === "GET" || request.method === "DELETE"
          ? undefined
          : await request.text();
      calls.push({
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body,
      });
      return handler(request, calls[calls.length - 1]);
    },
  };
}

/** A fake Durable Object namespace: idFromName + get(id).fetch(...). */
function makeNamespace(handler) {
  const calls = [];
  const idFromNameCalls = [];
  return {
    calls,
    idFromNameCalls,
    idFromName(name) {
      idFromNameCalls.push(name);
      return `id:${name}`;
    },
    get(id) {
      return {
        async fetch(request) {
          const body =
            request.method === "GET" || request.method === "DELETE"
              ? undefined
              : await request.text();
          calls.push({
            id,
            method: request.method,
            url: request.url,
            headers: Object.fromEntries(request.headers),
            body,
          });
          return handler(request, calls[calls.length - 1]);
        },
      };
    },
  };
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// ---- getSandbox: id validation ---------------------------------------------

test("getSandbox throws synchronously on an invalid id", () => {
  const fetcher = makeFetcher(() => jsonResponse({}));
  assert.throws(() => getSandbox(fetcher, "has spaces"), /Invalid sandbox id/);
  assert.throws(() => getSandbox(fetcher, ""), /Invalid sandbox id/);
  assert.throws(() => getSandbox(fetcher, "a".repeat(129)), /Invalid sandbox id/);
});

test("getSandbox accepts a valid id and exposes it as .id", () => {
  const fetcher = makeFetcher(() => jsonResponse({}));
  const sandbox = getSandbox(fetcher, "user-42.foo_bar");
  assert.equal(sandbox.id, "user-42.foo_bar");
});

test("normalizeId lowercases the id before validating/using it", () => {
  const fetcher = makeFetcher(() => jsonResponse({ success: true, path: "/x", exists: true, timestamp: iso() }));
  const sandbox = getSandbox(fetcher, "USER-42", { normalizeId: true });
  assert.equal(sandbox.id, "user-42");
});

// ---- Fetcher transport: path/URL per method --------------------------------

test("Fetcher target: createCodeContext POSTs /sandboxes/<id>/contexts and converts dates", async () => {
  const createdAt = iso(-1000);
  const lastUsed = iso();
  const fetcher = makeFetcher((request) => {
    if (request.method === "POST")
      return jsonResponse(
        { id: "ctx-1", language: "javascript", cwd: "/workspace", createdAt, lastUsed },
        { status: 201 },
      );
    return jsonResponse({});
  });
  const sandbox = getSandbox(fetcher, "s1");
  const ctx = await sandbox.createCodeContext({
    language: "javascript",
    cwd: "/workspace",
    envVars: { A: "1", B: undefined },
  });
  assert.equal(fetcher.calls[0].method, "POST");
  assert.equal(fetcher.calls[0].url, "https://sandbox.internal/sandboxes/s1/contexts");
  assert.deepEqual(JSON.parse(fetcher.calls[0].body), {
    language: "javascript",
    cwd: "/workspace",
    envVars: { A: "1" },
  });
  assert.equal(ctx.id, "ctx-1");
  assert.ok(ctx.createdAt instanceof Date);
  assert.ok(ctx.lastUsed instanceof Date);
  assert.equal(ctx.createdAt.getTime(), Date.parse(createdAt));
  assert.equal(ctx.lastUsed.getTime(), Date.parse(lastUsed));
});

test("Fetcher target: listCodeContexts GETs /sandboxes/<id>/contexts and maps each context", async () => {
  const createdAt = iso(-1000);
  const lastUsed = iso();
  const fetcher = makeFetcher(() =>
    jsonResponse({
      contexts: [
        { id: "ctx-1", language: "javascript", cwd: "/workspace", createdAt, lastUsed },
        { id: "ctx-2", language: "python", cwd: "/workspace", createdAt, lastUsed },
      ],
    }),
  );
  const sandbox = getSandbox(fetcher, "s1");
  const contexts = await sandbox.listCodeContexts();
  assert.equal(fetcher.calls[0].method, "GET");
  assert.equal(fetcher.calls[0].url, "https://sandbox.internal/sandboxes/s1/contexts");
  assert.equal(contexts.length, 2);
  assert.ok(contexts[0].createdAt instanceof Date);
  assert.equal(contexts[1].id, "ctx-2");
});

test("Fetcher target: deleteCodeContext DELETEs /sandboxes/<id>/contexts/<encoded id>", async () => {
  const fetcher = makeFetcher(() => new Response(null, { status: 204 }));
  const sandbox = getSandbox(fetcher, "s1");
  await sandbox.deleteCodeContext("ctx/weird id");
  assert.equal(fetcher.calls[0].method, "DELETE");
  assert.equal(
    fetcher.calls[0].url,
    `https://sandbox.internal/sandboxes/s1/contexts/${encodeURIComponent("ctx/weird id")}`,
  );
});

test("Fetcher target: runCode posts code/contextId/language/envVars, omitting unset keys", async () => {
  const fetcher = makeFetcher(() =>
    jsonResponse({
      code: "1+1",
      logs: { stdout: [], stderr: [] },
      results: [],
      language: "javascript",
      engine: "spidermonkey",
      durationMs: 1,
    }),
  );
  const sandbox = getSandbox(fetcher, "s1");
  await sandbox.runCode("1+1");
  assert.equal(fetcher.calls[0].method, "POST");
  assert.equal(fetcher.calls[0].url, "https://sandbox.internal/sandboxes/s1/execute");
  assert.deepEqual(JSON.parse(fetcher.calls[0].body), { code: "1+1" });

  await sandbox.runCode("2+2", {
    context: { id: "ctx-1", language: "javascript", cwd: "/workspace", createdAt: new Date(), lastUsed: new Date() },
    language: "javascript",
    envVars: { X: "1", Y: undefined },
  });
  assert.deepEqual(JSON.parse(fetcher.calls[1].body), {
    code: "2+2",
    contextId: "ctx-1",
    language: "javascript",
    envVars: { X: "1" },
  });
});

test("Fetcher target: setEnvVars sends undefined values as null", async () => {
  const fetcher = makeFetcher(() => jsonResponse({ success: true }));
  const sandbox = getSandbox(fetcher, "s1");
  await sandbox.setEnvVars({ TOKEN: "abc", OLD: undefined });
  assert.equal(fetcher.calls[0].url, "https://sandbox.internal/sandboxes/s1/env");
  assert.deepEqual(JSON.parse(fetcher.calls[0].body), {
    envVars: { TOKEN: "abc", OLD: null },
  });
});

test("Fetcher target: writeFile encodes a string as utf-8 (and normalizes utf8), a Uint8Array as base64", async () => {
  const fetcher = makeFetcher(() =>
    jsonResponse({ success: true, path: "/workspace/a.txt", timestamp: iso() }),
  );
  const sandbox = getSandbox(fetcher, "s1");

  await sandbox.writeFile("/workspace/a.txt", "hi");
  assert.equal(fetcher.calls[0].url, "https://sandbox.internal/sandboxes/s1/files");
  assert.deepEqual(JSON.parse(fetcher.calls[0].body), {
    op: "write",
    path: "/workspace/a.txt",
    content: "hi",
    encoding: "utf-8",
  });

  await sandbox.writeFile("/workspace/a.txt", "hi", { encoding: "utf8" });
  assert.deepEqual(JSON.parse(fetcher.calls[1].body), {
    op: "write",
    path: "/workspace/a.txt",
    content: "hi",
    encoding: "utf-8",
  });

  const bytes = Uint8Array.from([104, 105]); // "hi"
  await sandbox.writeFile("/workspace/bin.dat", bytes);
  const parsed = JSON.parse(fetcher.calls[2].body);
  assert.equal(parsed.op, "write");
  assert.equal(parsed.encoding, "base64");
  assert.equal(parsed.content, Buffer.from(bytes).toString("base64"));
});

test("Fetcher target: readFile/mkdir/deleteFile/renameFile/moveFile/listFiles/exists wire mapping", async () => {
  const fetcher = makeFetcher(() => jsonResponse({ success: true, timestamp: iso() }));
  const sandbox = getSandbox(fetcher, "s1");

  await sandbox.readFile("/workspace/a.txt", { encoding: "base64" });
  assert.deepEqual(JSON.parse(fetcher.calls[0].body), {
    op: "read",
    path: "/workspace/a.txt",
    encoding: "base64",
  });

  await sandbox.mkdir("/workspace/dir", { recursive: true });
  assert.deepEqual(JSON.parse(fetcher.calls[1].body), {
    op: "mkdir",
    path: "/workspace/dir",
    recursive: true,
  });

  await sandbox.deleteFile("/workspace/dir", { recursive: true, force: true });
  assert.deepEqual(JSON.parse(fetcher.calls[2].body), {
    op: "delete",
    path: "/workspace/dir",
    recursive: true,
    force: true,
  });

  await sandbox.renameFile("/workspace/a.txt", "/workspace/b.txt");
  assert.deepEqual(JSON.parse(fetcher.calls[3].body), {
    op: "rename",
    path: "/workspace/a.txt",
    newPath: "/workspace/b.txt",
  });

  await sandbox.moveFile("/workspace/b.txt", "/workspace/dir/b.txt");
  assert.deepEqual(JSON.parse(fetcher.calls[4].body), {
    op: "move",
    path: "/workspace/b.txt",
    newPath: "/workspace/dir/b.txt",
  });

  await sandbox.listFiles("/workspace", { recursive: true, includeHidden: false });
  assert.deepEqual(JSON.parse(fetcher.calls[5].body), {
    op: "list",
    path: "/workspace",
    recursive: true,
    includeHidden: false,
  });

  await sandbox.exists("/workspace/dir/b.txt");
  assert.deepEqual(JSON.parse(fetcher.calls[6].body), {
    op: "exists",
    path: "/workspace/dir/b.txt",
  });

  for (const call of fetcher.calls)
    assert.equal(call.url, "https://sandbox.internal/sandboxes/s1/files");
});

test("Fetcher target: getInfo GETs /sandboxes/<id>, destroy DELETEs /sandboxes/<id>", async () => {
  const fetcher = makeFetcher(() => jsonResponse({ id: "s1" }));
  const sandbox = getSandbox(fetcher, "s1");
  await sandbox.getInfo();
  assert.equal(fetcher.calls[0].method, "GET");
  assert.equal(fetcher.calls[0].url, "https://sandbox.internal/sandboxes/s1");
  await sandbox.destroy();
  assert.equal(fetcher.calls[1].method, "DELETE");
  assert.equal(fetcher.calls[1].url, "https://sandbox.internal/sandboxes/s1");
});

test("204 responses resolve to {} rather than attempting to parse a body", async () => {
  const fetcher = makeFetcher(() => new Response(null, { status: 204 }));
  const sandbox = getSandbox(fetcher, "s1");
  const result = await sandbox.readFile("/workspace/a.txt");
  assert.deepEqual(result, {});
});

// ---- Durable Object namespace transport ------------------------------------

test("namespace target: idFromName is called with the id, x-sandbox-id header is set, path has no /sandboxes/<id> prefix", async () => {
  const namespace = makeNamespace(() => jsonResponse({ success: true, timestamp: iso() }));
  const sandbox = getSandbox(namespace, "s1");
  await sandbox.exists("/workspace/a.txt");
  assert.deepEqual(namespace.idFromNameCalls, ["s1"]);
  assert.equal(namespace.calls[0].id, "id:s1");
  assert.equal(namespace.calls[0].url, "https://sandbox.internal/files");
  assert.equal(namespace.calls[0].headers["x-sandbox-id"], "s1");
});

test("namespace target: getInfo/destroy hit the bare root path", async () => {
  const namespace = makeNamespace(() => jsonResponse({ id: "s1" }));
  const sandbox = getSandbox(namespace, "s1");
  await sandbox.getInfo();
  assert.equal(namespace.calls[0].url, "https://sandbox.internal/");
  await sandbox.destroy();
  assert.equal(namespace.calls[1].method, "DELETE");
});

// ---- runCode callbacks ------------------------------------------------------

test("runCode invokes onStdout/onStderr/onResult/onError in order with the right payloads", async () => {
  const fetcher = makeFetcher(() =>
    jsonResponse({
      code: "code",
      logs: { stdout: ["out1", "out2"], stderr: ["err1"] },
      results: [{ text: "42" }, { json: { a: 1 } }],
      error: { name: "Error", message: "boom", traceback: [] },
      language: "javascript",
      engine: "spidermonkey",
      durationMs: 1,
    }),
  );
  const sandbox = getSandbox(fetcher, "s1");
  const calls = [];
  const result = await sandbox.runCode("code", {
    onStdout: (o) => {
      calls.push(["stdout", o]);
    },
    onStderr: (o) => {
      calls.push(["stderr", o]);
    },
    onResult: (r) => {
      calls.push(["result", { text: r.text, json: r.json, formats: r.formats() }]);
    },
    onError: (e) => {
      calls.push(["error", e]);
    },
  });

  assert.equal(calls.length, 6);
  assert.equal(calls[0][0], "stdout");
  assert.equal(calls[0][1].text, "out1");
  assert.equal(typeof calls[0][1].timestamp, "number");
  assert.equal(calls[1][0], "stdout");
  assert.equal(calls[1][1].text, "out2");
  assert.equal(calls[2][0], "stderr");
  assert.equal(calls[2][1].text, "err1");
  assert.equal(calls[3][0], "result");
  assert.deepEqual(calls[3][1], { text: "42", json: undefined, formats: ["text"] });
  assert.equal(calls[4][0], "result");
  assert.deepEqual(calls[4][1], { text: undefined, json: { a: 1 }, formats: ["json"] });
  assert.equal(calls[5][0], "error");
  assert.equal(calls[5][1].message, "boom");
  assert.equal(result.error.message, "boom");
});

test("runCode throws on an invalid response shape", async () => {
  const fetcher = makeFetcher(() => jsonResponse({ notAResult: true }));
  const sandbox = getSandbox(fetcher, "s1");
  await assert.rejects(
    () => sandbox.runCode("code"),
    (err) => err instanceof SandboxError && err.code === ErrorCode.INTERNAL_ERROR,
  );
});

// ---- signal forwarding -------------------------------------------------------

test("an already-aborted signal makes the underlying fetch reject, and the rejection propagates", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = { fetch: (request) => fetch(request) };
  const sandbox = getSandbox(fetcher, "s1");
  await assert.rejects(() => sandbox.runCode("1+1", { signal: controller.signal }));
});

// ---- error mapping -----------------------------------------------------------

function errorResponseBody(code, context = {}) {
  return {
    code,
    message: `${code} happened`,
    context,
    httpStatus: 400,
    timestamp: iso(),
    operation: "someOp",
  };
}

test("createErrorFromResponse maps each ErrorCode to its class", () => {
  const cases = [
    [ErrorCode.FILE_NOT_FOUND, FileNotFoundError],
    [ErrorCode.FILE_EXISTS, FileExistsError],
    [ErrorCode.FILE_TOO_LARGE, FileTooLargeError],
    [ErrorCode.PERMISSION_DENIED, PermissionDeniedError],
    [ErrorCode.NO_SPACE, FileSystemError],
    [ErrorCode.IS_DIRECTORY, FileSystemError],
    [ErrorCode.NOT_DIRECTORY, FileSystemError],
    [ErrorCode.FILESYSTEM_ERROR, FileSystemError],
    [ErrorCode.CONTEXT_NOT_FOUND, ContextNotFoundError],
    [ErrorCode.VALIDATION_FAILED, ValidationFailedError],
    [ErrorCode.CODE_EXECUTION_ERROR, CodeExecutionError],
  ];
  for (const [code, Class] of cases) {
    const err = createErrorFromResponse(errorResponseBody(code));
    assert.ok(err instanceof Class, `${code} should map to ${Class.name}`);
    assert.ok(err instanceof SandboxError);
    assert.equal(err.name, Class.name);
    assert.equal(err.code, code);
  }
});

test("createErrorFromResponse maps an unknown code to a plain SandboxError", () => {
  const err = createErrorFromResponse(errorResponseBody("SOMETHING_ELSE"));
  assert.equal(err.constructor, SandboxError);
  assert.equal(err.name, "SandboxError");
  assert.equal(err.code, "SOMETHING_ELSE");
});

test("createErrorFromResponse falls back to INTERNAL_ERROR for a non-JSON/malformed body", () => {
  const err = createErrorFromResponse(undefined, { status: 502, statusText: "Bad Gateway" });
  assert.ok(err instanceof SandboxError);
  assert.equal(err.code, ErrorCode.INTERNAL_ERROR);
  assert.equal(err.httpStatus, 502);
  assert.equal(err.message, "HTTP 502: Bad Gateway");

  const err2 = createErrorFromResponse("plain text body");
  assert.equal(err2.code, ErrorCode.INTERNAL_ERROR);
  assert.equal(err2.message, "HTTP 500: ");
});

test("end-to-end: a non-ok JSON error response is mapped through getSandbox", async () => {
  const fetcher = makeFetcher(() =>
    jsonResponse(
      { code: ErrorCode.FILE_NOT_FOUND, message: "no such file", context: { path: "/a", operation: "readFile" }, httpStatus: 404, timestamp: iso() },
      { status: 404 },
    ),
  );
  const sandbox = getSandbox(fetcher, "s1");
  await assert.rejects(
    () => sandbox.readFile("/a"),
    (err) => err instanceof FileNotFoundError && err.context.path === "/a",
  );
});

test("end-to-end: a non-JSON error response becomes INTERNAL_ERROR with 'HTTP <status>: <statusText>'", async () => {
  const fetcher = makeFetcher(
    () => new Response("<html>gateway error</html>", { status: 502, statusText: "Bad Gateway" }),
  );
  const sandbox = getSandbox(fetcher, "s1");
  await assert.rejects(
    () => sandbox.readFile("/a"),
    (err) =>
      err instanceof SandboxError &&
      err.code === ErrorCode.INTERNAL_ERROR &&
      err.message === "HTTP 502: Bad Gateway",
  );
});

// ---- errorResponse() ---------------------------------------------------------

test("errorResponse() for an ApiError uses its own fields", async () => {
  const err = new ApiError(404, "not found", ErrorCode.FILE_NOT_FOUND, { path: "/a" }, "readFile");
  const response = errorResponse(err);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, ErrorCode.FILE_NOT_FOUND);
  assert.equal(body.message, "not found");
  assert.deepEqual(body.context, { path: "/a" });
  assert.equal(body.httpStatus, 404);
  assert.equal(body.operation, "readFile");
  assert.equal(typeof body.timestamp, "string");
});

test("errorResponse() for a SandboxError uses its errorResponse", async () => {
  const err = new SandboxError({
    code: ErrorCode.CONTEXT_NOT_FOUND,
    message: "no such context",
    context: { contextId: "ctx-1" },
    httpStatus: 404,
    timestamp: iso(),
  });
  const response = errorResponse(err);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, ErrorCode.CONTEXT_NOT_FOUND);
  assert.deepEqual(body.context, { contextId: "ctx-1" });
});

test("errorResponse() for a plain Error returns a 502 INTERNAL_ERROR", async () => {
  const response = errorResponse(new Error("boom"));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.deepEqual(body, {
    code: ErrorCode.INTERNAL_ERROR,
    message: "Engine execution failed",
    context: {},
    httpStatus: 502,
    timestamp: body.timestamp,
  });
});

// ---- errnoErrorResponse() -----------------------------------------------------

test("errnoErrorResponse maps ENOENT/EEXIST/ENOTEMPTY to the right code/status/context.errno", async () => {
  const enoent = errnoErrorResponse("ENOENT", "no such file", { path: "/a", operation: "readFile" });
  assert.equal(enoent.status, 404);
  const enoentBody = await enoent.json();
  assert.equal(enoentBody.code, ErrorCode.FILE_NOT_FOUND);
  assert.equal(enoentBody.context.errno, "ENOENT");
  assert.equal(enoentBody.context.path, "/a");

  const eexist = errnoErrorResponse("EEXIST", "already exists", { path: "/b", operation: "writeFile" });
  assert.equal(eexist.status, 409);
  const eexistBody = await eexist.json();
  assert.equal(eexistBody.code, ErrorCode.FILE_EXISTS);
  assert.equal(eexistBody.context.errno, "EEXIST");

  const enotempty = errnoErrorResponse("ENOTEMPTY", "directory not empty", { path: "/c", operation: "deleteFile" });
  assert.equal(enotempty.status, 400);
  const enotemptyBody = await enotempty.json();
  assert.equal(enotemptyBody.code, ErrorCode.FILESYSTEM_ERROR);
  assert.equal(enotemptyBody.context.errno, "ENOTEMPTY");
});
