// The single implementation of a sandbox's /workspace: an in-memory tree
// built from the WASI shim's own Directory/File classes so WASI languages can
// mount it directly as a preopen, plus the operations the HTTP files API and
// the JavaScript host `fs` facade both call. See docs/sessions-design.md and
// docs/sandbox-1-0-design.md ("Workspace module").
//
// Moved here (from `runtime/workspace.mjs`) so it can be shared, as built
// TypeScript, by both the sandbox Durable Object (`packages/core/src/
// sandbox.ts`) and every runtime Worker's interpreter Durable Object
// (`InterpreterServer`, packages/interpreter/src/server.ts);
// `runtime/workspace.mjs` is now a one-line re-export of this module.
import { Directory, File } from "@bjorn3/browser_wasi_shim";
import type { Inode } from "@bjorn3/browser_wasi_shim";

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
export const WORKSPACE_TAG: unique symbol = Symbol("workspace");

export class WorkspaceError extends Error {
  code: string;
  // `details` carries extra context fields beyond {path, operation, errno}
  // (e.g. FileTooLargeError's `maxSize`/`actualSize`) for _files to merge
  // into the context it passes to errnoErrorResponse.
  details?: Record<string, unknown>;
  constructor(code: string, message?: string, details?: Record<string, unknown>) {
    super(message || code);
    this.name = "WorkspaceError";
    this.code = code;
    this.details = details;
  }
}

export type Encoding = "utf-8" | "base64";

function toBytes(content: string | Uint8Array, encoding?: Encoding): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (encoding === "base64") {
    let binary: string;
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

function fromBytes(bytes: Uint8Array, encoding?: Encoding): string {
  if (encoding === "base64") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Heuristic used for the `isBinary` flag on `read`: not valid UTF-8, or
// contains a NUL byte (legal UTF-8 but never intentional in text files).
function looksBinary(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0");
  } catch {
    return true;
  }
}

// FNV-1a-ish 64-bit-strength (two 32-bit lanes) hash for cheap change
// detection between `changes(since)` calls (and now `manifest()`/`applySync`).
// Not cryptographic; workspaces are capped at 4096 entries / 16 MiB so a full
// walk per call is inexpensive.
export function hashBytes(bytes: Uint8Array): string {
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
function upgrade(entry: Inode): Inode {
  if (entry instanceof Directory && !(entry instanceof WorkspaceDirectory)) {
    Object.setPrototypeOf(entry, WorkspaceDirectory.prototype);
  } else if (entry instanceof File && !(entry instanceof WorkspaceFile)) {
    Object.setPrototypeOf(entry, WorkspaceFile.prototype);
    (entry as WorkspaceFile).updatedAt = Date.now();
  }
  return entry;
}

export class WorkspaceFile extends File {
  updatedAt: number;
  constructor(data: ArrayBuffer | SharedArrayBuffer | Uint8Array | Array<number>, options?: Partial<{ readonly: boolean; updatedAt: number }>) {
    super(data, options);
    this.updatedAt = options?.updatedAt ?? Date.now();
  }
  touch(): void {
    this.updatedAt = Date.now();
  }
  // NOTE: the installed @bjorn3/browser_wasi_shim@0.4.2 moved fd_write/
  // fd_pwrite/fd_filestat_set_size off `File` and onto `OpenFile` (the fd
  // wrapper around a File, which tracks its own file_pos); `File` itself no
  // longer declares them, so there is no base implementation left to
  // delegate to via `super`. These overrides are therefore never reached by
  // WASI's own actual read/write path (OpenFile mutates `this.file.data`
  // directly rather than calling back into `File`), but are reimplemented
  // here inline -- mirroring OpenFile's real logic -- rather than a `super`
  // call, so byte-cap enforcement and `updatedAt` tracking still hold if
  // anything ever calls these directly on a WorkspaceFile.
  fd_write(data: Uint8Array): { ret: number; nwritten: number } {
    if (!this.readonly && this.data.byteLength + data.byteLength > LIMITS.MAX_FILE_BYTES)
      return { ret: 22 /* ERRNO_FBIG */, nwritten: 0 };
    if (this.readonly) return { ret: 8 /* ERRNO_BADF */, nwritten: 0 };
    const merged = new Uint8Array(this.data.byteLength + data.byteLength);
    merged.set(this.data, 0);
    merged.set(data, this.data.byteLength);
    this.data = merged;
    this.touch();
    return { ret: 0, nwritten: data.byteLength };
  }
  fd_pwrite(data: Uint8Array, offset: bigint): { ret: number; nwritten: number } {
    if (!this.readonly && Number(offset) + data.byteLength > LIMITS.MAX_FILE_BYTES)
      return { ret: 22 /* ERRNO_FBIG */, nwritten: 0 };
    if (this.readonly) return { ret: 8 /* ERRNO_BADF */, nwritten: 0 };
    if (offset + BigInt(data.byteLength) > BigInt(this.data.byteLength)) {
      const grown = new Uint8Array(Number(offset + BigInt(data.byteLength)));
      grown.set(this.data, 0);
      this.data = grown;
    }
    this.data.set(data, Number(offset));
    this.touch();
    return { ret: 0, nwritten: data.byteLength };
  }
  fd_filestat_set_size(size: bigint): number {
    if (Number(size) > LIMITS.MAX_FILE_BYTES) return 22 /* ERRNO_FBIG */;
    if (this.data.byteLength > Number(size)) {
      this.data = this.data.slice(0, Number(size));
    } else {
      const grown = new Uint8Array(Number(size));
      grown.set(this.data, 0);
      this.data = grown;
    }
    this.touch();
    return 0;
  }
}
(WorkspaceFile.prototype as unknown as Record<symbol, boolean>)[WORKSPACE_TAG] = true;

export class WorkspaceDirectory extends Directory {
  create_entry_for_path(path_str: string, is_dir: boolean): { ret: number; entry: Inode | null } {
    const result = super.create_entry_for_path(path_str, is_dir);
    if (result.entry) upgrade(result.entry);
    return result;
  }
}
(WorkspaceDirectory.prototype as unknown as Record<symbol, boolean>)[WORKSPACE_TAG] = true;

export interface ReadOptions {
  encoding?: Encoding;
}
export interface ReadResult {
  content: string;
  size: number;
  encoding: Encoding;
  isBinary: boolean;
  updatedAt: number;
}
export interface WriteOptions {
  encoding?: Encoding;
}
export interface WriteResult {
  size: number;
}
export interface MkdirOptions {
  recursive?: boolean;
}
export interface ListOptions {
  recursive?: boolean;
}
export interface ListEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  updatedAt: number;
}
export interface ListResult {
  entries: ListEntry[];
}
export interface DeleteOptions {
  recursive?: boolean;
  force?: boolean;
}
export interface ExistsResult {
  exists: boolean;
}
export interface StatResult {
  type: "file" | "directory";
  size: number;
  updatedAt: number;
}
export interface ModuleSourceResult {
  ok: boolean;
  source?: Uint8Array;
}
export interface ChangesResult {
  created: string[];
  updated: string[];
  deleted: string[];
  snapshot: Map<string, string>;
}
export interface SerializedRow {
  path: string;
  data: Uint8Array | null;
  updatedAt: number;
}
export interface WorkspaceStats {
  files: number;
  bytes: number;
}
export interface WorkspaceManifest {
  dirs: string[];
  files: Record<string, string>;
}
export interface SyncFileEntry {
  path: string;
  /**
   * File contents: a base64 string (used by callers still on that
   * transcoding, e.g. `restoreFrom`'s row shape) or raw bytes (the RPC wire
   * format; see docs/sandbox-1-0-design.md, "Workspace mirror and sync
   * protocol"). `toBytes` passes a `Uint8Array` through unchanged regardless
   * of `encoding`.
   */
  data: string | Uint8Array;
  updatedAt: number;
}
export interface ApplySyncPayload {
  /** Every directory that should exist under /workspace after this sync, absolute paths. */
  dirs: string[];
  /** Files to write (create or update), base64 contents. */
  files: SyncFileEntry[];
  /**
   * Explicit list of file paths to remove. Used when the caller already knows
   * exactly what was deleted (e.g. the sandbox applying an interpreter's
   * response diff). Ignored when `manifest` is given -- deletions are then
   * derived from the manifest instead.
   */
  deleted?: string[];
  /**
   * Full path->hash manifest of what the workspace should hold once synced.
   * When given, every file not named here is deleted, and the returned
   * `missing` array lists any manifest path whose post-sync hash still
   * doesn't match -- the interpreter pulls those paths from the sandbox over
   * the `getFiles` RPC callback before executing (see
   * docs/sandbox-1-0-design.md).
   */
  manifest?: Record<string, string>;
}
export interface ApplySyncResult {
  missing: string[];
}
export interface LoadRow {
  path: string;
  data: Uint8Array | ArrayLike<number> | null;
  updatedAt?: number;
  updated_at?: number;
}

export class Workspace {
  root: WorkspaceDirectory;

  // Set by the interpreter Durable Object per execute, from
  // `InterpreterWorkspaceManifest.disabled` -- the sandbox Durable Object
  // never sets it. When true, every guest op below rejects with EACCES.
  disabled = false;

  constructor() {
    this.root = new WorkspaceDirectory(new Map());
  }

  private assertEnabled(): void {
    if (this.disabled) throw new WorkspaceError("EACCES", "File API is disabled for this sandbox");
  }

  // Resolves `path` (absolute under /workspace, or relative to `cwd`, an
  // absolute path itself under /workspace) into path segments relative to
  // the workspace root, rejecting any escape above /workspace with EACCES.
  normalize(path: string, cwd: string): { segments: string[]; absolute: string } {
    if (typeof path !== "string" || path.length === 0)
      throw new WorkspaceError("ENOENT", "Path is required");
    const base = path.startsWith("/") ? path : `${cwd}/${path}`;
    const parts: string[] = [];
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

  private _lookup(segments: string[]): Inode | undefined {
    let node: Inode = this.root;
    for (const seg of segments) {
      if (!(node instanceof Directory)) throw new WorkspaceError("ENOTDIR", "Not a directory");
      const child = node.contents.get(seg);
      if (!child) return undefined;
      node = child;
    }
    return node;
  }

  private _walkParent(segments: string[]): Directory {
    let dir: Directory = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const child = dir.contents.get(seg);
      if (!child) throw new WorkspaceError("ENOENT", "No such file or directory");
      if (!(child instanceof Directory)) throw new WorkspaceError("ENOTDIR", "Not a directory");
      dir = child;
    }
    return dir;
  }

  private _countEntries(): number {
    let count = 0;
    const walk = (dir: Directory) => {
      for (const child of dir.contents.values()) {
        count++;
        if (child instanceof Directory) walk(child);
      }
    };
    walk(this.root);
    return count;
  }

  private _totalBytes(): number {
    let total = 0;
    const walk = (dir: Directory) => {
      for (const child of dir.contents.values()) {
        if (child instanceof Directory) walk(child);
        else total += (child as File).data.byteLength;
      }
    };
    walk(this.root);
    return total;
  }

  read(path: string, cwd: string, options: ReadOptions = {}): ReadResult {
    this.assertEnabled();
    const encoding = options.encoding ?? "utf-8";
    const { segments } = this.normalize(path, cwd);
    const node = segments.length === 0 ? (this.root as Inode) : this._lookup(segments);
    if (!node) throw new WorkspaceError("ENOENT", `No such file: ${path}`);
    if (node instanceof Directory) throw new WorkspaceError("EISDIR", `Is a directory: ${path}`);
    const file = node as WorkspaceFile;
    const bytes = file.data;
    return {
      content: fromBytes(bytes, encoding),
      size: bytes.byteLength,
      encoding,
      isBinary: looksBinary(bytes),
      updatedAt: file.updatedAt ?? 0,
    };
  }

  // Raw byte read, with none of `read()`'s utf-8/base64 transcoding -- used
  // by the RPC wire format (docs/sandbox-1-0-design.md, "Workspace mirror
  // and sync protocol"), where file contents travel as `Uint8Array` directly
  // rather than as a JSON string.
  readBytes(path: string, cwd: string): { data: Uint8Array; updatedAt: number } {
    this.assertEnabled();
    const { segments } = this.normalize(path, cwd);
    const node = segments.length === 0 ? (this.root as Inode) : this._lookup(segments);
    if (!node) throw new WorkspaceError("ENOENT", `No such file: ${path}`);
    if (node instanceof Directory) throw new WorkspaceError("EISDIR", `Is a directory: ${path}`);
    const file = node as WorkspaceFile;
    return { data: file.data, updatedAt: file.updatedAt ?? 0 };
  }

  write(path: string, cwd: string, content: string | Uint8Array, options: WriteOptions = {}): WriteResult {
    this.assertEnabled();
    const encoding = options.encoding ?? "utf-8";
    const { segments } = this.normalize(path, cwd);
    if (segments.length === 0)
      throw new WorkspaceError("EISDIR", "Cannot write to the /workspace root");
    const bytes = toBytes(content, encoding);
    if (bytes.byteLength > LIMITS.MAX_FILE_BYTES)
      throw new WorkspaceError("EFBIG", `File exceeds ${LIMITS.MAX_FILE_BYTES} bytes`, {
        maxSize: LIMITS.MAX_FILE_BYTES,
        actualSize: bytes.byteLength,
      });
    const parent = this._walkParent(segments);
    const name = segments.at(-1) as string;
    const existing = parent.contents.get(name);
    if (existing instanceof Directory)
      throw new WorkspaceError("EISDIR", `Is a directory: ${path}`);
    const previousSize = existing ? (existing as File).data.byteLength : 0;
    if (this._totalBytes() - previousSize + bytes.byteLength > LIMITS.MAX_TOTAL_BYTES)
      throw new WorkspaceError("ENOSPC", "Workspace exceeds 16 MiB total");
    if (!existing && this._countEntries() >= LIMITS.MAX_ENTRIES)
      throw new WorkspaceError("ENOSPC", "Workspace exceeds 4096 entries");
    parent.contents.set(name, new WorkspaceFile(bytes));
    return { size: bytes.byteLength };
  }

  mkdir(path: string, cwd: string, options: MkdirOptions = {}): Record<string, never> {
    this.assertEnabled();
    const { segments } = this.normalize(path, cwd);
    if (segments.length === 0) return {};
    if (options.recursive) {
      let dir: Directory = this.root;
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
        // TypeScript can't fully narrow `child` back to `Directory` across
        // this if/else-if reassignment+instanceof merge; both branches
        // guarantee it, so this cast is safe.
        dir = child as Directory;
      }
      return {};
    }
    const parent = this._walkParent(segments);
    const name = segments.at(-1) as string;
    if (parent.contents.has(name))
      throw new WorkspaceError("EEXIST", `Already exists: ${path}`);
    if (this._countEntries() >= LIMITS.MAX_ENTRIES)
      throw new WorkspaceError("ENOSPC", "Workspace exceeds 4096 entries");
    parent.contents.set(name, new WorkspaceDirectory(new Map()));
    return {};
  }

  list(path: string, cwd: string, options: ListOptions = {}): ListResult {
    this.assertEnabled();
    const { segments, absolute } = this.normalize(path, cwd);
    const node = segments.length === 0 ? (this.root as Inode) : this._lookup(segments);
    if (!node) throw new WorkspaceError("ENOENT", `No such directory: ${path}`);
    if (!(node instanceof Directory))
      throw new WorkspaceError("ENOTDIR", `Not a directory: ${path}`);
    const entries: ListEntry[] = [];
    const walk = (dir: Directory, prefix: string) => {
      for (const [name, child] of dir.contents) {
        const entryPath = `${prefix}/${name}`;
        const isDir = child instanceof Directory;
        entries.push({
          path: entryPath,
          type: isDir ? "directory" : "file",
          size: isDir ? 0 : (child as File).data.byteLength,
          updatedAt: isDir ? 0 : ((child as WorkspaceFile).updatedAt ?? 0),
        });
        if (isDir && options.recursive) walk(child as Directory, entryPath);
      }
    };
    walk(node, absolute);
    return { entries };
  }

  delete(path: string, cwd: string, options: DeleteOptions = {}): Record<string, never> {
    this.assertEnabled();
    const { segments } = this.normalize(path, cwd);
    if (segments.length === 0)
      throw new WorkspaceError("EACCES", "Cannot delete the /workspace root");
    let parent: Directory;
    try {
      parent = this._walkParent(segments);
    } catch (error) {
      if (options.force && error instanceof WorkspaceError && error.code === "ENOENT") return {};
      throw error;
    }
    const name = segments.at(-1) as string;
    const node = parent.contents.get(name);
    if (!node) {
      if (options.force) return {};
      throw new WorkspaceError("ENOENT", `No such file or directory: ${path}`);
    }
    // Mirrors the SDK: deleteFile() refuses a directory outright (even an
    // empty one) unless `recursive: true` is passed — there's no separate
    // "not empty" case here (unlike rename's overwrite check below).
    if (node instanceof Directory && !options.recursive)
      throw new WorkspaceError(
        "EISDIR",
        `Cannot delete directory with deleteFile() at '${path}'. Pass { recursive: true } to delete a directory.`,
      );
    parent.contents.delete(name);
    return {};
  }

  rename(from: string, to: string, cwd: string): Record<string, never> {
    this.assertEnabled();
    const src = this.normalize(from, cwd);
    const dst = this.normalize(to, cwd);
    if (src.segments.length === 0)
      throw new WorkspaceError("EACCES", "Cannot rename the /workspace root");
    if (dst.segments.length === 0)
      throw new WorkspaceError("EACCES", "Cannot rename onto the /workspace root");
    const srcParent = this._walkParent(src.segments);
    const srcName = src.segments.at(-1) as string;
    const node = srcParent.contents.get(srcName);
    if (!node) throw new WorkspaceError("ENOENT", `No such file or directory: ${from}`);
    const dstParent = this._walkParent(dst.segments);
    const dstName = dst.segments.at(-1) as string;
    const existing = dstParent.contents.get(dstName);
    if (existing) {
      const srcIsDir = node instanceof Directory;
      const dstIsDir = existing instanceof Directory;
      if (srcIsDir && !dstIsDir) throw new WorkspaceError("ENOTDIR", `Not a directory: ${to}`);
      if (!srcIsDir && dstIsDir) throw new WorkspaceError("EISDIR", `Is a directory: ${to}`);
      if (dstIsDir && (existing as Directory).contents.size > 0)
        throw new WorkspaceError("ENOTEMPTY", `Directory not empty: ${to}`);
    }
    srcParent.contents.delete(srcName);
    dstParent.contents.set(dstName, node);
    return {};
  }

  exists(path: string, cwd: string): ExistsResult {
    if (this.disabled) return { exists: false };
    try {
      const { segments } = this.normalize(path, cwd);
      return { exists: segments.length === 0 || this._lookup(segments) !== undefined };
    } catch {
      return { exists: false };
    }
  }

  stat(path: string, cwd: string): StatResult {
    this.assertEnabled();
    const { segments } = this.normalize(path, cwd);
    const node = segments.length === 0 ? (this.root as Inode) : this._lookup(segments);
    if (!node) throw new WorkspaceError("ENOENT", `No such file or directory: ${path}`);
    const isDir = node instanceof Directory;
    return {
      type: isDir ? "directory" : "file",
      size: isDir ? 0 : (node as File).data.byteLength,
      updatedAt: isDir ? 0 : ((node as WorkspaceFile).updatedAt ?? 0),
    };
  }

  // Only .js/.mjs/.json files under /workspace are served to the JS module
  // loader. `referrer` is informational: the engine already resolved `./`
  // and `../` against it before calling the host, so `spec` here only needs
  // interpreting relative to the workspace root.
  moduleSource(spec: string, referrer: string): ModuleSourceResult {
    void referrer;
    if (this.disabled) return { ok: false };
    if (!/\.(m?js|json)$/i.test(spec)) return { ok: false };
    let segments: string[];
    try {
      ({ segments } = this.normalize(spec.startsWith("/") ? spec : `/workspace/${spec}`, "/workspace"));
    } catch {
      return { ok: false };
    }
    let node: Inode | undefined;
    try {
      node = this._lookup(segments);
    } catch {
      return { ok: false };
    }
    if (!node || node instanceof Directory) return { ok: false };
    return { ok: true, source: (node as File).data };
  }

  // Diffs the current tree against `since` (a Map<path, hash> from a
  // previous call, or omitted for the first call) by content hash. Returns
  // the changed paths and a fresh snapshot Map to pass to the next call.
  changes(since: Map<string, string> = new Map()): ChangesResult {
    const current = new Map<string, string>();
    const walk = (dir: Directory, prefix: string) => {
      for (const [name, child] of dir.contents) {
        const path = `${prefix}/${name}`;
        if (child instanceof Directory) walk(child, path);
        else current.set(path, hashBytes((child as File).data));
      }
    };
    walk(this.root, "/workspace");
    const created: string[] = [],
      updated: string[] = [],
      deleted: string[] = [];
    for (const [path, hash] of current) {
      if (!since.has(path)) created.push(path);
      else if (since.get(path) !== hash) updated.push(path);
    }
    for (const path of since.keys()) if (!current.has(path)) deleted.push(path);
    return { created, updated, deleted, snapshot: current };
  }

  // Every directory (absolute, sorted, root excluded) and every file's
  // content hash, keyed by absolute path. Used to build/validate the sync
  // payload between the sandbox and an interpreter (see
  // docs/sandbox-1-0-design.md, "Workspace mirror and sync protocol").
  manifest(): WorkspaceManifest {
    const dirs: string[] = [];
    const files: Record<string, string> = {};
    const walk = (dir: Directory, prefix: string) => {
      for (const [name, child] of dir.contents) {
        const path = `${prefix}/${name}`;
        if (child instanceof Directory) {
          dirs.push(path);
          walk(child, path);
        } else {
          files[path] = hashBytes((child as File).data);
        }
      }
    };
    walk(this.root, "/workspace");
    dirs.sort();
    return { dirs, files };
  }

  // Flat list of {path, data, updatedAt} for every file AND directory,
  // matching a `files` table shaped `path TEXT PRIMARY KEY, data BLOB,
  // updated_at INTEGER` where a NULL `data` row is a directory (see
  // docs/sandbox-1-0-design.md's `Sandbox` Durable Object).
  serialize(): SerializedRow[] {
    const rows: SerializedRow[] = [];
    const walk = (dir: Directory, prefix: string) => {
      for (const [name, child] of dir.contents) {
        const path = `${prefix}/${name}`;
        if (child instanceof Directory) {
          rows.push({ path, data: null, updatedAt: 0 });
          walk(child, path);
        } else {
          const file = child as WorkspaceFile;
          rows.push({ path, data: file.data, updatedAt: file.updatedAt ?? Date.now() });
        }
      }
    };
    walk(this.root, "/workspace");
    return rows;
  }

  stats(): WorkspaceStats {
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
  restoreFrom(rows: LoadRow[]): void {
    const fresh = Workspace.load(rows);
    this.root.contents.clear();
    for (const [name, node] of fresh.root.contents) this.root.contents.set(name, node);
  }

  // Ensures a WorkspaceDirectory exists at every path component of
  // `absolute` (an absolute path under /workspace), creating any missing
  // intermediate directories -- without the entry-count limit checks the
  // public `mkdir()` applies, since callers here (applySync) are
  // reconciling against an already-limits-checked source of truth (the
  // sandbox's own tree), not accepting arbitrary guest input.
  private _ensureDirPath(absolute: string): void {
    const { segments } = this.normalize(absolute, "/workspace");
    let dir: Directory = this.root;
    for (const seg of segments) {
      let child = dir.contents.get(seg);
      if (!child || !(child instanceof Directory)) {
        child = new WorkspaceDirectory(new Map());
        dir.contents.set(seg, child);
      }
      // See the matching comment in mkdir(): TypeScript can't fully narrow
      // `child` back to `Directory` here either.
      dir = child as Directory;
    }
  }

  // Writes `bytes` at `absolute`, creating any missing intermediate
  // directories (mirroring _ensureDirPath's no-limits-check policy) and
  // preserving the given `updatedAt` instead of stamping Date.now() (the
  // sync payload's `updatedAt` is the value the sending side already has).
  private _putFile(absolute: string, bytes: Uint8Array, updatedAt: number): void {
    const { segments } = this.normalize(absolute, "/workspace");
    if (segments.length === 0) return;
    let dir: Directory = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = dir.contents.get(seg);
      if (!child || !(child instanceof Directory)) {
        child = new WorkspaceDirectory(new Map());
        dir.contents.set(seg, child);
      }
      // See the matching comment in mkdir(): TypeScript can't fully narrow
      // `child` back to `Directory` here either.
      dir = child as Directory;
    }
    dir.contents.set(segments.at(-1) as string, new WorkspaceFile(bytes, { updatedAt }));
  }

  // Removes whatever is at `absolute` (file or directory, with its
  // subtree), ignoring a missing path or an invalid one.
  private _removePath(absolute: string): void {
    try {
      const { segments } = this.normalize(absolute, "/workspace");
      if (segments.length === 0) return;
      let dir: Directory = this.root;
      for (let i = 0; i < segments.length - 1; i++) {
        const child = dir.contents.get(segments[i]);
        if (!child || !(child instanceof Directory)) return;
        dir = child;
      }
      dir.contents.delete(segments.at(-1) as string);
    } catch {
      // ignore invalid paths
    }
  }

  // Reconciles this tree in place against a sync payload, in the fixed order
  // required by the mirror protocol (docs/sandbox-1-0-design.md, "Workspace
  // mirror and sync protocol"): create every directory in `dirs`, then write
  // `files`, then delete files no longer wanted, then delete directories no
  // longer wanted (deepest first). Keeps `root`'s identity, like
  // `restoreFrom`.
  //
  // Deletions: when `manifest` is given (the interpreter's own reconciliation
  // of an incoming request), every current file whose path isn't a key of
  // `manifest` is deleted, and the returned `missing` array lists any
  // manifest path whose post-sync hash still doesn't match (triggering a
  // `getFiles` RPC pull from the sandbox). Without `manifest` (the sandbox applying an
  // interpreter's response `workspace` diff), the explicit `deleted` list is
  // used instead, and `missing` is always empty.
  applySync(payload: ApplySyncPayload): ApplySyncResult {
    for (const dirPath of payload.dirs) this._ensureDirPath(dirPath);
    for (const file of payload.files) this._putFile(file.path, toBytes(file.data, "base64"), file.updatedAt);

    if (payload.manifest) {
      const keep = new Set(Object.keys(payload.manifest));
      const currentFiles: string[] = [];
      const walkFiles = (dir: Directory, prefix: string) => {
        for (const [name, child] of dir.contents) {
          const path = `${prefix}/${name}`;
          if (child instanceof Directory) walkFiles(child, path);
          else currentFiles.push(path);
        }
      };
      walkFiles(this.root, "/workspace");
      for (const path of currentFiles) if (!keep.has(path)) this._removePath(path);
    } else if (payload.deleted) {
      for (const path of payload.deleted) this._removePath(path);
    }

    const keepDirs = new Set(payload.dirs);
    const currentDirs: string[] = [];
    const walkDirs = (dir: Directory, prefix: string) => {
      for (const [name, child] of dir.contents) {
        if (child instanceof Directory) {
          const path = `${prefix}/${name}`;
          currentDirs.push(path);
          walkDirs(child, path);
        }
      }
    };
    walkDirs(this.root, "/workspace");
    currentDirs
      .filter((path) => !keepDirs.has(path))
      .sort((a, b) => b.split("/").length - a.split("/").length)
      .forEach((path) => this._removePath(path));

    if (!payload.manifest) return { missing: [] };
    const missing: string[] = [];
    const current = this.manifest().files;
    for (const [path, hash] of Object.entries(payload.manifest)) {
      if (current[path] !== hash) missing.push(path);
    }
    return { missing };
  }

  static load(rows: LoadRow[]): Workspace {
    const workspace = new Workspace();
    for (const row of rows) {
      const path = row.path;
      const parts = path.split("/").filter(Boolean);
      const rel = parts[0] === "workspace" ? parts.slice(1) : parts;
      if (rel.length === 0) continue;
      let dir: WorkspaceDirectory = workspace.root;
      for (let i = 0; i < rel.length - 1; i++) {
        const seg = rel[i];
        let child = dir.contents.get(seg);
        if (!child) {
          child = new WorkspaceDirectory(new Map());
          dir.contents.set(seg, child);
        }
        dir = child as WorkspaceDirectory;
      }
      const name = rel.at(-1) as string;
      if (row.data === null) {
        if (!dir.contents.has(name)) dir.contents.set(name, new WorkspaceDirectory(new Map()));
        continue;
      }
      const raw = row.data;
      const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const updatedAt = row.updatedAt ?? row.updated_at ?? Date.now();
      dir.contents.set(name, new WorkspaceFile(data, { updatedAt }));
    }
    return workspace;
  }
}
