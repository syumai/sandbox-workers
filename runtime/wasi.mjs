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
export class ExecutionLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExecutionLimitError";
  }
}
export function budget(fuel = 100_000_000) {
  let remaining = fuel;
  return {
    tick() {
      if (--remaining < 0)
        throw new ExecutionLimitError("Execution fuel exhausted");
    },
    usage(memory) {
      if (remaining < 0)
        throw new ExecutionLimitError("Execution fuel exhausted");
      return {
        fuelConsumed: fuel - remaining,
        fuelLimit: fuel,
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
export function createWasi(module, archive, meter) {
  const logs = [];
  let size = 0;
  const capture = (level, text) => {
    size += new TextEncoder().encode(text).length;
    if (!text) return;
    if (size > 32768 || logs.length >= 200)
      throw new ExecutionLimitError("Output limit exceeded");
    logs.push({ level, text });
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
  const wasi = new WASI(
    ["sandbox"],
    [],
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
      new PreopenDirectory("/stdlib", root),
      new PreopenDirectory("/dev", new Map([["null", new NullFile()]])),
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
  // In-memory, read-only library mount; no writes, sockets, processes or waiting.
  for (const name of Object.keys(imports.wasi_snapshot_preview1)) {
    if (
      /^(path_(create|link|symlink|unlink|remove|rename)|.*filestat_set|fd_(allocate|pwrite)|sock_|proc_spawn|pipe$|proc_wait|poll_oneoff)/.test(
        name,
      )
    )
      imports.wasi_snapshot_preview1[name] = () => 63;
  }
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
  imports.wasi_snapshot_preview1.path_open = (...args) =>
    args[4] & 9 ? 63 : open(...args);
  imports.wasi_snapshot_preview1.path_filestat_mode = () => 63;
  imports.sandbox = { tick: meter.tick };
  return { wasi, imports, logs, capture };
}
