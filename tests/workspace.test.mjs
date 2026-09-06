// Pure Node unit tests for runtime/workspace.mjs. No Workers runtime needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspace, WorkspaceError, LIMITS } from "../runtime/workspace.mjs";

test("write then read round-trips utf-8 content", () => {
  const ws = new Workspace();
  ws.write("/workspace/a.txt", "/workspace", "hello");
  const result = ws.read("/workspace/a.txt", "/workspace");
  assert.equal(result.content, "hello");
  assert.equal(result.size, 5);
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.isBinary, false);
});

test("write/read round-trips base64 binary content", () => {
  const ws = new Workspace();
  const bytes = Uint8Array.from([0, 1, 2, 255, 254]);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  ws.write("/workspace/bin.dat", "/workspace", b64, { encoding: "base64" });
  const result = ws.read("/workspace/bin.dat", "/workspace", { encoding: "base64" });
  assert.equal(result.content, b64);
  assert.equal(result.isBinary, true);
});

test("relative paths resolve against cwd", () => {
  const ws = new Workspace();
  ws.mkdir("/workspace/sub", "/workspace");
  ws.write("file.txt", "/workspace/sub", "x");
  const result = ws.read("/workspace/sub/file.txt", "/workspace");
  assert.equal(result.content, "x");
});

test("path escape above /workspace is rejected with EACCES", () => {
  const ws = new Workspace();
  assert.throws(
    () => ws.read("../../etc/passwd", "/workspace"),
    (err) => err instanceof WorkspaceError && err.code === "EACCES",
  );
  assert.throws(
    () => ws.read("/etc/passwd", "/workspace"),
    (err) => err instanceof WorkspaceError && err.code === "EACCES",
  );
});

test("read of a missing file is ENOENT", () => {
  const ws = new Workspace();
  assert.throws(
    () => ws.read("/workspace/missing.txt", "/workspace"),
    (err) => err.code === "ENOENT",
  );
});

test("read of a directory is EISDIR", () => {
  const ws = new Workspace();
  ws.mkdir("/workspace/dir", "/workspace");
  assert.throws(
    () => ws.read("/workspace/dir", "/workspace"),
    (err) => err.code === "EISDIR",
  );
});

test("write through a non-directory parent is ENOTDIR", () => {
  const ws = new Workspace();
  ws.write("/workspace/file.txt", "/workspace", "x");
  assert.throws(
    () => ws.write("/workspace/file.txt/child.txt", "/workspace", "x"),
    (err) => err.code === "ENOTDIR",
  );
});

test("mkdir without recursive fails on missing parent (ENOENT) and existing path (EEXIST)", () => {
  const ws = new Workspace();
  assert.throws(
    () => ws.mkdir("/workspace/a/b", "/workspace"),
    (err) => err.code === "ENOENT",
  );
  ws.mkdir("/workspace/a", "/workspace");
  assert.throws(
    () => ws.mkdir("/workspace/a", "/workspace"),
    (err) => err.code === "EEXIST",
  );
});

test("mkdir recursive creates intermediate directories", () => {
  const ws = new Workspace();
  ws.mkdir("/workspace/a/b/c", "/workspace", { recursive: true });
  assert.deepEqual(ws.exists("/workspace/a/b/c", "/workspace"), { exists: true });
});

test("list returns entries with absolute paths, recursive walks subdirectories", () => {
  const ws = new Workspace();
  ws.mkdir("/workspace/sub", "/workspace");
  ws.write("/workspace/top.txt", "/workspace", "1");
  ws.write("/workspace/sub/nested.txt", "/workspace", "22");
  const shallow = ws.list("/workspace", "/workspace");
  const paths = shallow.entries.map((e) => e.path).sort();
  assert.deepEqual(paths, ["/workspace/sub", "/workspace/top.txt"]);
  const deep = ws.list("/workspace", "/workspace", { recursive: true });
  const deepPaths = deep.entries.map((e) => e.path).sort();
  assert.deepEqual(deepPaths, [
    "/workspace/sub",
    "/workspace/sub/nested.txt",
    "/workspace/top.txt",
  ]);
});

test("delete rejects any directory (even empty) without recursive; recursive deletes contents; force ignores missing", () => {
  const ws = new Workspace();
  ws.mkdir("/workspace/sub", "/workspace");
  ws.write("/workspace/sub/f.txt", "/workspace", "x");
  // A non-empty directory without recursive fails EISDIR (not ENOTEMPTY —
  // deleteFile() refuses directories outright, mirroring the SDK).
  assert.throws(
    () => ws.delete("/workspace/sub", "/workspace"),
    (err) => err.code === "EISDIR",
  );
  // An empty directory without recursive also fails EISDIR.
  ws.mkdir("/workspace/empty", "/workspace");
  assert.throws(
    () => ws.delete("/workspace/empty", "/workspace"),
    (err) => err.code === "EISDIR",
  );
  ws.delete("/workspace/sub", "/workspace", { recursive: true });
  assert.deepEqual(ws.exists("/workspace/sub", "/workspace"), { exists: false });
  ws.delete("/workspace/empty", "/workspace", { recursive: true });
  assert.deepEqual(ws.exists("/workspace/empty", "/workspace"), { exists: false });
  // force on a missing path does not throw
  ws.delete("/workspace/missing", "/workspace", { force: true });
});

test("rename moves a file and rejects overwriting a non-empty directory", () => {
  const ws = new Workspace();
  ws.write("/workspace/a.txt", "/workspace", "x");
  ws.rename("/workspace/a.txt", "/workspace/b.txt", "/workspace");
  assert.deepEqual(ws.exists("/workspace/a.txt", "/workspace"), { exists: false });
  assert.equal(ws.read("/workspace/b.txt", "/workspace").content, "x");

  ws.mkdir("/workspace/dir", "/workspace");
  ws.write("/workspace/dir/inner.txt", "/workspace", "y");
  assert.throws(
    () => ws.rename("/workspace/b.txt", "/workspace/dir", "/workspace"),
    (err) => err.code === "EISDIR",
  );
  ws.mkdir("/workspace/dir2", "/workspace");
  assert.throws(
    () => ws.rename("/workspace/dir2", "/workspace/dir", "/workspace"),
    (err) => err.code === "ENOTEMPTY",
  );
});

test("stat reports type, size, and updatedAt", () => {
  const ws = new Workspace();
  ws.write("/workspace/a.txt", "/workspace", "hello");
  const s = ws.stat("/workspace/a.txt", "/workspace");
  assert.equal(s.type, "file");
  assert.equal(s.size, 5);
  assert.ok(s.updatedAt > 0);
  const dirStat = ws.stat("/workspace", "/workspace");
  assert.equal(dirStat.type, "directory");
});

test("per-file limit is enforced (EFBIG), with maxSize/actualSize in details", () => {
  const ws = new Workspace();
  const big = "x".repeat(LIMITS.MAX_FILE_BYTES + 1);
  assert.throws(
    () => ws.write("/workspace/big.txt", "/workspace", big),
    (err) =>
      err.code === "EFBIG" &&
      err.details.maxSize === LIMITS.MAX_FILE_BYTES &&
      err.details.actualSize === LIMITS.MAX_FILE_BYTES + 1,
  );
});

test("total workspace size limit is enforced (ENOSPC)", () => {
  const ws = new Workspace();
  // Fill close to the cap with one big-but-legal file, then try to exceed it.
  const chunk = "x".repeat(LIMITS.MAX_FILE_BYTES);
  const filesNeeded = Math.floor(LIMITS.MAX_TOTAL_BYTES / LIMITS.MAX_FILE_BYTES);
  for (let i = 0; i < filesNeeded; i++) {
    ws.write(`/workspace/f${i}.txt`, "/workspace", chunk);
  }
  assert.throws(
    () => ws.write("/workspace/overflow.txt", "/workspace", "x"),
    (err) => err.code === "ENOSPC",
  );
});

test("entry count limit is enforced (ENOSPC)", () => {
  const ws = new Workspace();
  for (let i = 0; i < LIMITS.MAX_ENTRIES; i++) {
    ws.write(`/workspace/f${i}.txt`, "/workspace", "x");
  }
  assert.throws(
    () => ws.write("/workspace/overflow.txt", "/workspace", "x"),
    (err) => err.code === "ENOSPC",
  );
});

test("changes(since) reports created, updated, and deleted paths", () => {
  const ws = new Workspace();
  ws.write("/workspace/a.txt", "/workspace", "1");
  const first = ws.changes();
  assert.deepEqual(first.created.sort(), ["/workspace/a.txt"]);
  assert.deepEqual(first.updated, []);
  assert.deepEqual(first.deleted, []);

  ws.write("/workspace/a.txt", "/workspace", "2");
  ws.write("/workspace/b.txt", "/workspace", "3");
  const second = ws.changes(first.snapshot);
  assert.deepEqual(second.created, ["/workspace/b.txt"]);
  assert.deepEqual(second.updated, ["/workspace/a.txt"]);
  assert.deepEqual(second.deleted, []);

  ws.delete("/workspace/a.txt", "/workspace");
  const third = ws.changes(second.snapshot);
  assert.deepEqual(third.deleted, ["/workspace/a.txt"]);
});

test("serialize/load round-trips the tree", () => {
  const ws = new Workspace();
  ws.mkdir("/workspace/sub", "/workspace");
  ws.write("/workspace/sub/f.txt", "/workspace", "hello");
  ws.write("/workspace/top.txt", "/workspace", "world");
  const rows = ws.serialize();
  assert.equal(rows.length, 2);

  const restored = Workspace.load(rows);
  assert.equal(restored.read("/workspace/sub/f.txt", "/workspace").content, "hello");
  assert.equal(restored.read("/workspace/top.txt", "/workspace").content, "world");
});

test("moduleSource only serves .js/.mjs/.json under /workspace", () => {
  const ws = new Workspace();
  ws.write("/workspace/lib.mjs", "/workspace", "export const x = 1;");
  ws.write("/workspace/data.json", "/workspace", "{}");
  ws.write("/workspace/notes.txt", "/workspace", "hi");

  const mjs = ws.moduleSource("lib.mjs", "");
  assert.equal(mjs.ok, true);
  assert.equal(new TextDecoder().decode(mjs.source), "export const x = 1;");

  const json = ws.moduleSource("data.json", "lib.mjs");
  assert.equal(json.ok, true);

  assert.equal(ws.moduleSource("notes.txt", "").ok, false);
  assert.equal(ws.moduleSource("missing.mjs", "").ok, false);
  assert.equal(ws.moduleSource("../outside.mjs", "").ok, false);
});

test("WASI-created directories/files are upgraded and tagged for the mount policy", async () => {
  const { WORKSPACE_TAG } = await import("../runtime/workspace.mjs");
  const ws = new Workspace();
  // Simulate what the WASI shim does when a guest calls mkdir/open(O_CREAT):
  // it calls Directory.create_entry_for_path directly on the mounted dir.
  const { entry: dir } = ws.root.create_entry_for_path("guestdir", true);
  assert.ok(dir[WORKSPACE_TAG]);
  const { entry: file } = ws.root.create_entry_for_path("guestdir/guestfile.txt", false);
  assert.ok(file[WORKSPACE_TAG]);
  assert.ok(typeof file.updatedAt === "number");
});
