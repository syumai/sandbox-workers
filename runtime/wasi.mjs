import {
  WASI,
  Fd,
  File,
  Directory,
  OpenFile,
  PreopenDirectory,
  ConsoleStdout,
} from "@bjorn3/browser_wasi_shim";
import { unzipSync } from "fflate";
import { WORKSPACE_TAG } from "./workspace.mjs";
import { ExecutionLimitError } from "@sandbox-workers/core";
// Re-exported for every existing importer (runtime/javascript.mjs,
// runtime/embedded.mjs, runtime/ruby.mjs, the worker.ts files, tests): the
// class itself now lives in @sandbox-workers/core, so a plain `instanceof`
// check identifies it consistently across every module that imports it.
export { ExecutionLimitError };
export function budget(fuel = 100_000_000) {
  let limit = fuel;
  let remaining = fuel;
  return {
    tick() {
      if (--remaining < 0)
        throw new ExecutionLimitError("Execution fuel exhausted");
    },
    // Sessions reuse one instance across many executions and reset the
    // budget at the start of each one (stateless callers never call this).
    reset(newFuel) {
      limit = newFuel;
      remaining = newFuel;
    },
    usage(memory) {
      if (remaining < 0)
        throw new ExecutionLimitError("Execution fuel exhausted");
      return {
        fuelConsumed: limit - remaining,
        fuelLimit: limit,
        memoryBytes: memory.buffer.byteLength,
      };
    },
  };
}
class NullFile extends File {
  constructor() {
    super([]);
  }
  path_open() {
    return {
      ret: 0,
      fd_obj: new (class extends Fd {
        fd_read() {
          return { ret: 0, data: new Uint8Array() };
        }
        fd_write(data) {
          return { ret: 0, nwritten: data.length };
        }
        fd_fdstat_get() {
          return new OpenFile(new File([])).fd_fdstat_get();
        }
        fd_filestat_get() {
          return new OpenFile(new File([])).fd_filestat_get();
        }
      })(),
    };
  }
}
// WASI fd_write hands us raw write() chunks, which rarely line up with a
// single print/puts call (one call can split across chunks, or one chunk can
// hold several newline-terminated writes). Join the chunks captured for a
// stream and split on "\n" so each returned entry is one line, matching how
// the JS guest already reports one entry per console call.
function splitLines(chunks) {
  const joined = chunks.join("");
  if (!joined) return [];
  const lines = joined.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
// PreopenDirectory's own constructor wraps `contents` in a brand-new plain
// Directory (`super(new Directory(contents))`), which would strip the
// WORKSPACE_TAG-carrying subclass off the workspace root. Call super with a
// throwaway empty map (satisfying "call super before touching `this`"), then
// immediately point `.dir` at the real, already-tagged root so identity
// (and every subclass method) is preserved for the mount's own directory fd,
// not just for children created later.
class MountedPreopenDirectory extends PreopenDirectory {
  constructor(name, dir) {
    super(name, new Map());
    this.dir = dir;
  }
}

export function createWasi(module, archive, meter, envVars = {}, workspaceDir = null, options = {}) {
  // A getter, not a captured boolean: the sandbox can flip
  // `workspace.disabled` between executions of the same durable session (see
  // runtime/interpreter.mjs's `_executeInContext`), long after this host was
  // built at boot/restore time.
  const workspaceDisabled = options.workspaceDisabled ?? (() => false);
  const chunks = { stdout: [], stderr: [] };
  let size = 0;
  const capture = (level, text) => {
    size += new TextEncoder().encode(text).length;
    if (!text) return;
    if (size > 32768 || chunks.stdout.length + chunks.stderr.length >= 200)
      throw new ExecutionLimitError("Output limit exceeded");
    (level === "log" ? chunks.stdout : chunks.stderr).push(text);
  };
  const root = new Map();
  if (archive) {
    const entries = unzipSync(new Uint8Array(archive));
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith("/")) continue;
      const parts = name.split("/").filter(Boolean);
      if (parts.some((p) => p === ".."))
        throw new Error("Invalid archive path");
      let current = root;
      for (const part of parts.slice(0, -1)) {
        if (!current.has(part)) current.set(part, new Directory(new Map()));
        current = current.get(part).contents;
      }
      current.set(parts.at(-1), new File(data, { readonly: true }));
    }
  }
  // Fixed preopen order (/stdlib, /dev, then /workspace when present) is
  // part of the phase-2 snapshot contract: wasi-libc records preopen fd
  // numbers in linear memory, so the order must not change once a session
  // can restore a snapshot.
  const preopens = [
    new PreopenDirectory("/stdlib", root),
    new PreopenDirectory("/dev", new Map([["null", new NullFile()]])),
  ];
  if (workspaceDir) preopens.push(new MountedPreopenDirectory("/workspace", workspaceDir));
  const wasi = new WASI(
    ["sandbox"],
    Object.entries(envVars).map(([key, value]) => `${key}=${value}`),
    [
      new OpenFile(new File([], { readonly: true })),
      new ConsoleStdout((data) => {
        capture("log", new TextDecoder().decode(data));
        return data.length;
      }),
      new ConsoleStdout((data) => {
        capture("error", new TextDecoder().decode(data));
        return data.length;
      }),
      ...preopens,
    ],
    { debug: false },
  );
  const imports = {};
  for (const { module: ns, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== "function")
      throw new Error(`Unsupported import ${ns}.${name}`);
    (imports[ns] ??= {})[name] = () => {
      throw new Error(`Unsupported host capability: ${ns}.${name}`);
    };
  }
  Object.assign((imports.wasi_snapshot_preview1 ??= {}), wasi.wasiImport);
  // Directory-scoped write ops, three-way policy:
  //  - outside /workspace (e.g. /stdlib): always denied (EPERM) -- read-only
  //    library mount, never writable regardless of the workspace flag.
  //  - inside /workspace while the sandbox's File API is disabled
  //    (`workspaceDisabled()` true): denied (EACCES) -- the guest sees a
  //    permission error, matching JS's Workspace.disabled behavior.
  //  - inside /workspace otherwise: allowed, delegated to the real
  //    implementation.
  // Directory fd -> "belongs to /workspace" is decided via WORKSPACE_TAG (see
  // runtime/workspace.mjs). Capture the real implementations before the
  // blanket-deny loop below replaces them.
  const isWorkspaceFd = (fd) => {
    const entry = wasi.fds[fd];
    return !!(entry && entry.dir && entry.dir[WORKSPACE_TAG]);
  };
  const workspaceGated = [
    "path_create_directory",
    "path_unlink_file",
    "path_remove_directory",
    "path_rename",
  ];
  const gatedOriginals = {};
  for (const name of workspaceGated) gatedOriginals[name] = imports.wasi_snapshot_preview1[name];
  // In-memory, read-only library mount by default; no sockets, processes, or
  // waiting. path_link/path_symlink stay denied unconditionally (unused by
  // any supported guest); the four workspaceGated ops above are excluded
  // here and wired to their per-directory checks below instead.
  for (const name of Object.keys(imports.wasi_snapshot_preview1)) {
    if (workspaceGated.includes(name)) continue;
    if (
      /^(path_(create|link|symlink|unlink|remove|rename)|.*filestat_set|fd_(allocate|pwrite)|sock_|proc_spawn|pipe$|proc_wait|poll_oneoff)/.test(
        name,
      )
    )
      imports.wasi_snapshot_preview1[name] = () => 63;
  }
  const EACCES = 2, EPERM = 63;
  // 0 = allowed; EPERM outside /workspace (e.g. /stdlib); EACCES inside
  // /workspace while the sandbox's File API is disabled.
  const gate = (fd) => (!isWorkspaceFd(fd) ? EPERM : workspaceDisabled() ? EACCES : 0);
  for (const name of ["path_create_directory", "path_unlink_file", "path_remove_directory"])
    imports.wasi_snapshot_preview1[name] = (fd, ...rest) => gate(fd) || gatedOriginals[name](fd, ...rest);
  imports.wasi_snapshot_preview1.path_rename = (fd, oldPtr, oldLen, newFd, ...rest) =>
    gate(fd) || gate(newFd) || gatedOriginals.path_rename(fd, oldPtr, oldLen, newFd, ...rest);
  Object.assign((imports.env ??= {}), {
    getpid: () => 1,
    getuid: () => 1000,
    geteuid: () => 1000,
    getgid: () => 1000,
    getegid: () => 1000,
    getppid: () => 0,
    getpgrp: () => 1,
    umask: () => 0,
    tzset: () => 0,
    sigaction: () => 0,
    sigprocmask: () => 0,
    sigemptyset: () => 0,
    sigfillset: () => 0,
    sigaddset: () => 0,
    sigdelset: () => 0,
    sigismember: () => 0,
  });
  const open = imports.wasi_snapshot_preview1.path_open;
  // args: (fd, dirflags, path_ptr, path_len, oflags, ...). oflags bits 0
  // (CREAT) and 3 (TRUNC) are the only ones that can turn a read into a
  // write against something that doesn't already exist as a writable file;
  // outside /workspace those are always denied (EPERM), same as the four ops
  // above. Inside /workspace: reads AND writes are refused while disabled
  // (so a guest sees PermissionError, not FileNotFoundError) -- unlike the
  // four ops above, this can't be narrowed to just the write-ish oflags
  // because a plain read-only open must fail too.
  imports.wasi_snapshot_preview1.path_open = (...args) => {
    if (isWorkspaceFd(args[0])) return workspaceDisabled() ? EACCES : open(...args);
    return args[4] & 9 ? EPERM : open(...args);
  };
  const readdir = imports.wasi_snapshot_preview1.fd_readdir;
  imports.wasi_snapshot_preview1.fd_readdir = (fd, ...rest) =>
    isWorkspaceFd(fd) && workspaceDisabled() ? EACCES : readdir(fd, ...rest);
  imports.wasi_snapshot_preview1.path_filestat_mode = () => 63;
  imports.sandbox = { tick: meter.tick };
  return {
    wasi,
    imports,
    // Index of the first fd a guest could ever open itself (stdin/stdout/
    // stderr, then the fixed preopens above). Any fds.length beyond this
    // that are still non-undefined mean the guest holds an open file
    // descriptor -- see hasOpenGuestFds below.
    fdBase: 3 + preopens.length,
    get logs() {
      return { stdout: splitLines(chunks.stdout), stderr: splitLines(chunks.stderr) };
    },
    capture,
    // Sessions call this at the start of each execute(): stdout/stderr
    // (and the combined output-limit counter) would otherwise accumulate
    // across every execution the persistent instance ever runs.
    resetLogs() {
      chunks.stdout.length = 0;
      chunks.stderr.length = 0;
      size = 0;
    },
  };
}

// Snapshot precondition (see docs/sessions-design.md "Snapshot rules"): a
// guest that still holds a file descriptor beyond the fixed preopens (e.g. an
// `open()`ed file it never closed) may have host-side read/write position
// state that a memory-only snapshot can't capture faithfully. path_open
// pushes new entries onto wasi.fds and fd_close only sets the slot back to
// undefined (see @bjorn3/browser_wasi_shim's wasi.js), so any defined slot at
// or past fdBase means an open guest fd.
export function hasOpenGuestFds(host) {
  return host.wasi.fds.slice(host.fdBase).some((fd) => fd !== undefined);
}
