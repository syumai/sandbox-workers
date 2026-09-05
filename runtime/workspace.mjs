// The single implementation of a session's /workspace: an in-memory tree
// built from the WASI shim's own Directory/File classes so WASI languages can
// mount it directly as a preopen, plus the operations the HTTP files API and
// the JavaScript host `fs` facade both call. See docs/sessions-design.md.
import { Directory, File } from "@bjorn3/browser_wasi_shim";

export const LIMITS = {
  MAX_FILE_BYTES: 1024 * 1024, // 1 MiB per file
  MAX_TOTAL_BYTES: 16 * 1024 * 1024, // 16 MiB per workspace
  MAX_ENTRIES: 4096,
};

// Tagged on the prototypes of WorkspaceDirectory/WorkspaceFile below, so
// runtime/wasi.mjs can tell "this fd's directory belongs to /workspace" (for
// the write-capable path_open/path_create_directory/unlink/rename/rmdir
// policy) without importing the classes themselves. Instances created
// through the WASI layer itself (guest `mkdir`, `open(..., O_CREAT)`) are
// upgraded in place (see `upgrade` below) so the tag also survives writes
// made directly through WASI syscalls, not just through the API below.
export const WORKSPACE_TAG = Symbol("workspace");

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

function toBytes(content, encoding) {
  if (content instanceof Uint8Array) return content;
  if (encoding === "base64") {
    let binary;
    try {
      binary = atob(content);
    } catch {
      throw new WorkspaceError("EINVAL", "Invalid base64 content");
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(String(content));
}

function fromBytes(bytes, encoding) {
  if (encoding === "base64") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Heuristic used for the `isBinary` flag on `read`: not valid UTF-8, or
// contains a NUL byte (legal UTF-8 but never intentional in text files).
function looksBinary(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0");
  } catch {
    return true;
  }
}

// FNV-1a-ish 64-bit-strength (two 32-bit lanes) hash for cheap change
// detection between `changes(since)` calls. Not cryptographic; workspaces are
// capped at 4096 entries / 16 MiB so a full walk per call is inexpensive.
function hashBytes(bytes) {
  let h1 = 0x811c9dc5,
    h2 = 0x1000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 = (h1 ^ bytes[i]) >>> 0;
    h1 = Math.imul(h1, 0x01000193);
    h2 = (h2 + bytes[i]) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

// Upgrades a plain File/Directory (created by the WASI shim's own
// Directory.create_entry_for_path, e.g. from a guest `mkdir`/`open(O_CREAT)`)
// to our subclass in place, by swapping its prototype. This keeps identity
// (the object already lives in its parent's `contents` map) while giving it
// the workspace tag, the byte-cap enforcement, and `updatedAt` tracking.
function upgrade(entry) {
  if (entry instanceof Directory && !(entry instanceof WorkspaceDirectory)) {
    Object.setPrototypeOf(entry, WorkspaceDirectory.prototype);
  } else if (entry instanceof File && !(entry instanceof WorkspaceFile)) {
    Object.setPrototypeOf(entry, WorkspaceFile.prototype);
    entry.updatedAt = Date.now();
  }
  return entry;
}

export class WorkspaceFile extends File {
  constructor(data, options) {
    super(data, options);
    this.updatedAt = options?.updatedAt ?? Date.now();
  }
  touch() {
    this.updatedAt = Date.now();
  }
  fd_write(data) {
    if (!this.readonly && this.data.byteLength + data.byteLength > LIMITS.MAX_FILE_BYTES)
      return { ret: 22 /* ERRNO_FBIG */, nwritten: 0 };
    const result = super.fd_write(data);
    if (result.ret === 0) this.touch();
    return result;
  }
  fd_pwrite(data, offset) {
    if (!this.readonly && Number(offset) + data.byteLength > LIMITS.MAX_FILE_BYTES)
      return { ret: 22 /* ERRNO_FBIG */, nwritten: 0 };
    const result = super.fd_pwrite(data, offset);
    if (result.ret === 0) this.touch();
    return result;
  }
  fd_filestat_set_size(size) {
    if (Number(size) > LIMITS.MAX_FILE_BYTES) return 22 /* ERRNO_FBIG */;
    const ret = super.fd_filestat_set_size(size);
    if (ret === 0) this.touch();
    return ret;
  }
}
WorkspaceFile.prototype[WORKSPACE_TAG] = true;

export class WorkspaceDirectory extends Directory {
  create_entry_for_path(path_str, is_dir) {
    const result = super.create_entry_for_path(path_str, is_dir);
    if (result.entry) upgrade(result.entry);
    return result;
  }
}
WorkspaceDirectory.prototype[WORKSPACE_TAG] = true;

export class Workspace {
  constructor() {
    this.root = new WorkspaceDirectory(new Map());
  }

  // Resolves `path` (absolute under /workspace, or relative to `cwd`, an
  // absolute path itself under /workspace) into path segments relative to
  // the workspace root, rejecting any escape above /workspace with EACCES.
  normalize(path, cwd) {
    if (typeof path !== "string" || path.length === 0)
      throw new WorkspaceError("ENOENT", "Path is required");
    const base = path.startsWith("/") ? path : `${cwd}/${path}`;
    const parts = [];
    for (const seg of base.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0)
          throw new WorkspaceError("EACCES", `Path escapes /workspace: ${path}`);
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    if (parts.length === 0 || parts[0] !== "workspace")
      throw new WorkspaceError("EACCES", `Path escapes /workspace: ${path}`);
    const segments = parts.slice(1);
    return {
      segments,
      absolute: segments.length ? `/workspace/${segments.join("/")}` : "/workspace",
    };
  }

  _lookup(segments) {
    let node = this.root;
    for (const seg of segments) {
      if (!(node instanceof Directory)) throw new WorkspaceError("ENOTDIR", "Not a directory");
      const child = node.contents.get(seg);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  _walkParent(segments) {
    let dir = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const child = dir.contents.get(seg);
      if (!child) throw new WorkspaceError("ENOENT", "No such file or directory");
      if (!(child instanceof Directory)) throw new WorkspaceError("ENOTDIR", "Not a directory");
      dir = child;
    }
    return dir;
  }

  _countEntries() {
    let count = 0;
    const walk = (dir) => {
      for (const child of dir.contents.values()) {
        count++;
        if (child instanceof Directory) walk(child);
      }
    };
    walk(this.root);
    return count;
  }

  _totalBytes() {
    let total = 0;
    const walk = (dir) => {
      for (const child of dir.contents.values()) {
        if (child instanceof Directory) walk(child);
        else total += child.data.byteLength;
      }
    };
    walk(this.root);
    return total;
  }

  read(path, cwd, options = {}) {
    const encoding = options.encoding ?? "utf-8";
    const { segments } = this.normalize(path, cwd);
    const node = segments.length === 0 ? this.root : this._lookup(segments);
    if (!node) throw new WorkspaceError("ENOENT", `No such file: ${path}`);
    if (node instanceof Directory) throw new WorkspaceError("EISDIR", `Is a directory: ${path}`);
    const bytes = node.data;
    return {
      content: fromBytes(bytes, encoding),
      size: bytes.byteLength,
      encoding,
      isBinary: looksBinary(bytes),
      updatedAt: node.updatedAt ?? 0,
    };
  }

  write(path, cwd, content, options = {}) {
    const encoding = options.encoding ?? "utf-8";
    const { segments } = this.normalize(path, cwd);
    if (segments.length === 0)
      throw new WorkspaceError("EISDIR", "Cannot write to the /workspace root");
    const bytes = toBytes(content, encoding);
    if (bytes.byteLength > LIMITS.MAX_FILE_BYTES)
      throw new WorkspaceError("EFBIG", `File exceeds ${LIMITS.MAX_FILE_BYTES} bytes`);
    const parent = this._walkParent(segments);
    const name = segments.at(-1);
    const existing = parent.contents.get(name);
    if (existing instanceof Directory)
      throw new WorkspaceError("EISDIR", `Is a directory: ${path}`);
    const previousSize = existing ? existing.data.byteLength : 0;
    if (this._totalBytes() - previousSize + bytes.byteLength > LIMITS.MAX_TOTAL_BYTES)
      throw new WorkspaceError("ENOSPC", "Workspace exceeds 16 MiB total");
    if (!existing && this._countEntries() >= LIMITS.MAX_ENTRIES)
      throw new WorkspaceError("ENOSPC", "Workspace exceeds 4096 entries");
    parent.contents.set(name, new WorkspaceFile(bytes));
    return { size: bytes.byteLength };
  }

  mkdir(path, cwd, options = {}) {
    const { segments } = this.normalize(path, cwd);
    if (segments.length === 0) return {};
    if (options.recursive) {
      let dir = this.root;
      for (const seg of segments) {
        let child = dir.contents.get(seg);
        if (!child) {
          if (this._countEntries() >= LIMITS.MAX_ENTRIES)
            throw new WorkspaceError("ENOSPC", "Workspace exceeds 4096 entries");
          child = new WorkspaceDirectory(new Map());
          dir.contents.set(seg, child);
        } else if (!(child instanceof Directory)) {
          throw new WorkspaceError("ENOTDIR", "Not a directory");
        }
        dir = child;
      }
      return {};
    }
    const parent = this._walkParent(segments);
    const name = segments.at(-1);
    if (parent.contents.has(name))
      throw new WorkspaceError("EEXIST", `Already exists: ${path}`);
    if (this._countEntries() >= LIMITS.MAX_ENTRIES)
      throw new WorkspaceError("ENOSPC", "Workspace exceeds 4096 entries");
    parent.contents.set(name, new WorkspaceDirectory(new Map()));
    return {};
  }

  list(path, cwd, options = {}) {
    const { segments, absolute } = this.normalize(path, cwd);
    const node = segments.length === 0 ? this.root : this._lookup(segments);
    if (!node) throw new WorkspaceError("ENOENT", `No such directory: ${path}`);
    if (!(node instanceof Directory))
      throw new WorkspaceError("ENOTDIR", `Not a directory: ${path}`);
    const entries = [];
    const walk = (dir, prefix) => {
      for (const [name, child] of dir.contents) {
        const entryPath = `${prefix}/${name}`;
        const isDir = child instanceof Directory;
        entries.push({
          path: entryPath,
          type: isDir ? "directory" : "file",
          size: isDir ? 0 : child.data.byteLength,
          updatedAt: isDir ? 0 : (child.updatedAt ?? 0),
        });
        if (isDir && options.recursive) walk(child, entryPath);
      }
    };
    walk(node, absolute);
    return { entries };
  }

  delete(path, cwd, options = {}) {
    const { segments } = this.normalize(path, cwd);
    if (segments.length === 0)
      throw new WorkspaceError("EACCES", "Cannot delete the /workspace root");
    let parent;
    try {
      parent = this._walkParent(segments);
    } catch (error) {
      if (options.force && error instanceof WorkspaceError && error.code === "ENOENT") return {};
      throw error;
    }
    const name = segments.at(-1);
    const node = parent.contents.get(name);
    if (!node) {
      if (options.force) return {};
      throw new WorkspaceError("ENOENT", `No such file or directory: ${path}`);
    }
    if (node instanceof Directory && node.contents.size > 0 && !options.recursive)
      throw new WorkspaceError("ENOTEMPTY", `Directory not empty: ${path}`);
    parent.contents.delete(name);
    return {};
  }

  rename(from, to, cwd) {
    const src = this.normalize(from, cwd);
    const dst = this.normalize(to, cwd);
    if (src.segments.length === 0)
      throw new WorkspaceError("EACCES", "Cannot rename the /workspace root");
    if (dst.segments.length === 0)
      throw new WorkspaceError("EACCES", "Cannot rename onto the /workspace root");
    const srcParent = this._walkParent(src.segments);
    const srcName = src.segments.at(-1);
    const node = srcParent.contents.get(srcName);
    if (!node) throw new WorkspaceError("ENOENT", `No such file or directory: ${from}`);
    const dstParent = this._walkParent(dst.segments);
    const dstName = dst.segments.at(-1);
    const existing = dstParent.contents.get(dstName);
    if (existing) {
      const srcIsDir = node instanceof Directory;
      const dstIsDir = existing instanceof Directory;
      if (srcIsDir && !dstIsDir) throw new WorkspaceError("ENOTDIR", `Not a directory: ${to}`);
      if (!srcIsDir && dstIsDir) throw new WorkspaceError("EISDIR", `Is a directory: ${to}`);
      if (dstIsDir && existing.contents.size > 0)
        throw new WorkspaceError("ENOTEMPTY", `Directory not empty: ${to}`);
    }
    srcParent.contents.delete(srcName);
    dstParent.contents.set(dstName, node);
    return {};
  }

  exists(path, cwd) {
    try {
      const { segments } = this.normalize(path, cwd);
      return { exists: segments.length === 0 || this._lookup(segments) !== undefined };
    } catch {
      return { exists: false };
    }
  }

  stat(path, cwd) {
    const { segments } = this.normalize(path, cwd);
    const node = segments.length === 0 ? this.root : this._lookup(segments);
    if (!node) throw new WorkspaceError("ENOENT", `No such file or directory: ${path}`);
    const isDir = node instanceof Directory;
    return {
      type: isDir ? "directory" : "file",
      size: isDir ? 0 : node.data.byteLength,
      updatedAt: isDir ? 0 : (node.updatedAt ?? 0),
    };
  }

  // Only .js/.mjs/.json files under /workspace are served to the JS module
  // loader. `referrer` is informational: the engine already resolved `./`
  // and `../` against it before calling the host, so `spec` here only needs
  // interpreting relative to the workspace root.
  moduleSource(spec, referrer) {
    void referrer;
    if (!/\.(m?js|json)$/i.test(spec)) return { ok: false };
    let segments;
    try {
      ({ segments } = this.normalize(spec.startsWith("/") ? spec : `/workspace/${spec}`, "/workspace"));
    } catch {
      return { ok: false };
    }
    let node;
    try {
      node = this._lookup(segments);
    } catch {
      return { ok: false };
    }
    if (!node || node instanceof Directory) return { ok: false };
    return { ok: true, source: node.data };
  }

  // Diffs the current tree against `since` (a Map<path, hash> from a
  // previous call, or omitted for the first call) by content hash. Returns
  // the changed paths and a fresh snapshot Map to pass to the next call.
  changes(since = new Map()) {
    const current = new Map();
    const walk = (dir, prefix) => {
      for (const [name, child] of dir.contents) {
        const path = `${prefix}/${name}`;
        if (child instanceof Directory) walk(child, path);
        else current.set(path, hashBytes(child.data));
      }
    };
    walk(this.root, "/workspace");
    const created = [],
      updated = [],
      deleted = [];
    for (const [path, hash] of current) {
      if (!since.has(path)) created.push(path);
      else if (since.get(path) !== hash) updated.push(path);
    }
    for (const path of since.keys()) if (!current.has(path)) deleted.push(path);
    return { created, updated, deleted, snapshot: current };
  }

  // Flat list of {path, data, updatedAt} for every file, matching the
  // Durable Object's `files` table (path TEXT PRIMARY KEY, data BLOB,
  // updated_at INTEGER).
  serialize() {
    const files = [];
    const walk = (dir, prefix) => {
      for (const [name, child] of dir.contents) {
        const path = `${prefix}/${name}`;
        if (child instanceof Directory) walk(child, path);
        else files.push({ path, data: child.data, updatedAt: child.updatedAt ?? Date.now() });
      }
    };
    walk(this.root, "/workspace");
    return files;
  }

  stats() {
    return {
      files: this._countEntries(),
      bytes: this._totalBytes(),
    };
  }

  // Rolls the tree back to `rows` (the same shape serialize()/load() use) IN
  // PLACE: `this.root` and `this.root.contents` keep their identity, only
  // the entries are replaced. This matters because a session's WASI mount
  // and JS host functions capture a reference to `workspace.root` once at
  // boot time — replacing `this.root` itself (as a naive
  // `this.root = new WorkspaceDirectory(...)` would) would leave an
  // already-booted runtime instance looking at the old, discarded tree
  // forever. Used to discard a failed execution's workspace writes while
  // keeping the instance (and its persisted declarations) alive.
  restoreFrom(rows) {
    const fresh = Workspace.load(rows);
    this.root.contents.clear();
    for (const [name, node] of fresh.root.contents) this.root.contents.set(name, node);
  }

  static load(rows) {
    const workspace = new Workspace();
    for (const row of rows) {
      const path = row.path;
      const parts = path.split("/").filter(Boolean);
      const rel = parts[0] === "workspace" ? parts.slice(1) : parts;
      if (rel.length === 0) continue;
      let dir = workspace.root;
      for (let i = 0; i < rel.length - 1; i++) {
        const seg = rel[i];
        let child = dir.contents.get(seg);
        if (!child) {
          child = new WorkspaceDirectory(new Map());
          dir.contents.set(seg, child);
        }
        dir = child;
      }
      const raw = row.data;
      const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const updatedAt = row.updatedAt ?? row.updated_at ?? Date.now();
      dir.contents.set(rel.at(-1), new WorkspaceFile(data, { updatedAt }));
    }
    return workspace;
  }
}
