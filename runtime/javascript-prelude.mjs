// Prelude evaluated once per fresh SpiderMonkey runtime (js_new handle) before any
// guest code runs. It removes threading primitives the guest must not have, installs
// a console shim with the same shape/limits as the JavaScript sandbox has always
// exposed, and defines a non-enumerable, frozen __sandbox helper that evaluates the
// host's already-transformed script text and hands the JSON result back to the host
// through two js_eval round-trips (execute, then take).
export const javascriptPrelude = `(() => {
  "use strict";
  // The engine's linear memory is declared shared (for future thread-spawn support),
  // which brings SharedArrayBuffer/Atomics into scope. Atomics.wait would block the
  // one thread the guest runs on, so both are removed before any guest code runs.
  delete globalThis.SharedArrayBuffer;
  delete globalThis.Atomics;

  class ExecutionLimitError extends Error {
    constructor(message) {
      super(message);
      this.name = "ExecutionLimitError";
    }
  }

  // Strings pass through as-is, BigInt gets an "n" suffix, everything else is
  // JSON.stringify'd (falling back to String()).
  const format = (value) =>
    typeof value === "string"
      ? value
      : typeof value === "bigint"
        ? \`\${value}n\`
        : (JSON.stringify(value) ?? String(value));

  let stdout = [];
  let stderr = [];
  let units = 0;
  const capture = (list) => (...args) => {
    // One entry per console call; strip a single trailing newline so a stray
    // console.log("x\\n") matches the WASI languages' line-per-entry logs
    // instead of leaving a blank line in the array.
    const text = args.map(format).join(" ").replace(/\\n$/, "");
    units += text.length;
    // Limits: 200 entries / 32,768 UTF-16 code units combined across stdout and
    // stderr. The guest has no TextEncoder, so this counts UTF-16 units rather
    // than UTF-8 bytes.
    if (stdout.length + stderr.length >= 200 || units > 32768)
      throw new ExecutionLimitError("Console output limit exceeded");
    list.push(text);
  };
  globalThis.console = {
    log: capture(stdout),
    info: capture(stdout),
    debug: capture(stdout),
    warn: capture(stderr),
    error: capture(stderr),
  };

  const quote = (value) =>
    "'" + value.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'") + "'";
  const formatText = (value) => {
    if (typeof value === "string") return quote(value);
    if (typeof value === "bigint") return \`\${value}n\`;
    return String(value);
  };
  const replacer = (_key, value) =>
    typeof value === "bigint" ? \`\${value}n\` : value;
  const mapResult = (value) => {
    if (value === undefined) return [];
    let entry;
    if (typeof value === "object" && value !== null) {
      entry = { json: JSON.parse(JSON.stringify(value, replacer)) };
    } else {
      entry = { text: formatText(value) };
    }
    // The guest has no TextEncoder, so this counts UTF-16 units rather than
    // UTF-8 bytes; close enough to the 64 KiB cap for this purpose.
    if (JSON.stringify(entry).length > 65536)
      throw new ExecutionLimitError("Result limit exceeded");
    return [entry];
  };

  // The host's __sandbox.execute() result is stashed here rather than returned
  // directly: js_eval only reports a script's own completion value, and execute()
  // itself completes (as a statement) before its inner async job has settled.
  let slot;

  function execute(code, envVarsJson) {
    // Clear in place rather than reassigning: the console.log/warn/etc.
    // closures above captured these two array objects by reference when
    // globalThis.console was installed, so a fresh execute() must reuse them.
    stdout.length = 0;
    stderr.length = 0;
    units = 0;
    // Queued as a promise job; js_eval drains the job queue before returning, so
    // this settles within the same js_eval call unless it awaits something that
    // never resolves (there are no timers in this sandbox).
    (async () => {
      let final;
      try {
        globalThis.process = Object.freeze({
          env: Object.freeze(JSON.parse(envVarsJson)),
        });
        // \`code\` is already the host's transformForAsyncExecution() output: an
        // async IIFE whose completion value is the script's last expression.
        // Indirect eval runs it as top-level code (not the local scope of this
        // function), matching "code is a script" semantics.
        const value = await (0, eval)(code);
        final = {
          ok: true,
          results: mapResult(value),
          logs: { stdout, stderr },
        };
      } catch (error) {
        final = {
          ok: false,
          results: [],
          error: {
            name: String(error?.name ?? "Error"),
            message: String(error?.message ?? error),
            traceback: String(error?.stack ?? "")
              .slice(0, 8192)
              .split("\\n"),
          },
          logs: { stdout, stderr },
        };
      }
      slot = JSON.stringify(final);
    })();
  }

  function take() {
    const value = slot;
    slot = undefined;
    return value;
  }

  Object.defineProperty(globalThis, "__sandbox", {
    value: Object.freeze({ execute, take }),
    writable: false,
    enumerable: false,
    configurable: false,
  });
})();`;

// Evaluated once per session instance, right after javascriptPrelude. Unlike
// the stateless __sandbox.execute()/take() pair above (which runs user code
// through an INDIRECT eval — fine for a throwaway instance, but indirect
// eval does not persist let/const/class bindings to the real global), a
// session's user code is handed to js_eval DIRECTLY by the host as a
// top-level classic script so declarations persist like a browser console.
// __sandboxSession only captures the result/error/console output around
// that direct eval; it never evaluates the user's code itself.
export const javascriptSessionPrelude = `(() => {
  "use strict";
  class ExecutionLimitError extends Error {
    constructor(message) {
      super(message);
      this.name = "ExecutionLimitError";
    }
  }

  const format = (value) =>
    typeof value === "string"
      ? value
      : typeof value === "bigint"
        ? \`\${value}n\`
        : (JSON.stringify(value) ?? String(value));

  let stdout = [];
  let stderr = [];
  let units = 0;
  const capture = (list) => (...args) => {
    const text = args.map(format).join(" ").replace(/\\n$/, "");
    units += text.length;
    if (stdout.length + stderr.length >= 200 || units > 32768)
      throw new ExecutionLimitError("Console output limit exceeded");
    list.push(text);
  };
  globalThis.console = {
    log: capture(stdout),
    info: capture(stdout),
    debug: capture(stdout),
    warn: capture(stderr),
    error: capture(stderr),
  };

  const quote = (value) =>
    "'" + value.replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'") + "'";
  const formatText = (value) => {
    if (typeof value === "string") return quote(value);
    if (typeof value === "bigint") return \`\${value}n\`;
    return String(value);
  };
  const replacer = (_key, value) =>
    typeof value === "bigint" ? \`\${value}n\` : value;
  const mapResult = (value) => {
    if (value === undefined) return [];
    let entry;
    if (typeof value === "object" && value !== null) {
      entry = { json: JSON.parse(JSON.stringify(value, replacer)) };
    } else {
      entry = { text: formatText(value) };
    }
    if (JSON.stringify(entry).length > 65536)
      throw new ExecutionLimitError("Result limit exceeded");
    return [entry];
  };

  let hasCapture = false;
  let capturedValue;
  let capturedError;
  let done = false;

  function reset(envVarsJson) {
    stdout.length = 0;
    stderr.length = 0;
    units = 0;
    hasCapture = false;
    capturedValue = undefined;
    capturedError = undefined;
    done = false;
    const env = Object.freeze(JSON.parse(envVarsJson));
    if (globalThis.process && typeof globalThis.process === "object") {
      globalThis.process.env = env;
    } else {
      globalThis.process = { env };
    }
  }

  // Called by the host-transformed code in place of the script's last
  // top-level expression statement, so its value survives the eval call
  // that runs it (js_eval only reports its OWN completion value, and for
  // the hoisted/async shape the completion value is a Promise anyway).
  function setResult(value) {
    hasCapture = true;
    capturedValue = value;
  }

  // Called from the hoisted-transform's own try/catch (used only when the
  // code contains a top-level await, since that shape runs inside an async
  // IIFE whose internal exceptions never reach js_eval's own ok/error).
  function setError(error) {
    try {
      capturedError = {
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error),
        traceback: String(error?.stack ?? "").slice(0, 8192).split("\\n"),
      };
    } catch {
      capturedError = { name: "Error", message: "Unknown error", traceback: [] };
    }
  }

  function markDone() {
    done = true;
  }

  // \`expectAsync\` is true only for the hoisted/async-IIFE shape: since
  // js_eval drains the job queue before returning, the IIFE should already
  // have reached its finally block by the time this runs, UNLESS the guest
  // awaited something that never settles (there are no timers in this
  // sandbox) — that case is reported as an error rather than hanging.
  function end(expectAsync) {
    const logs = { stdout: stdout.slice(), stderr: stderr.slice() };
    if (capturedError !== undefined) {
      return JSON.stringify({ ok: false, results: [], error: capturedError, logs });
    }
    if (expectAsync && !done) {
      return JSON.stringify({
        ok: false,
        results: [],
        error: {
          name: "Error",
          message:
            "Execution did not complete: a promise never settled (timers and indefinitely pending promises are unsupported)",
          traceback: [],
        },
        logs,
      });
    }
    return JSON.stringify({ ok: true, results: hasCapture ? mapResult(capturedValue) : [], logs });
  }

  globalThis.__sandboxSession = { reset, setResult, setError, markDone, end };
})();`;

// Evaluated once per session instance, after the host has registered the
// private native functions (via js_define_function) named below. Builds the
// guest-visible fs/process facades on top of them. Binary data crosses the
// host boundary as base64 (encoded/decoded here, since this engine has no
// btoa/atob); failures thrown by the natives arrive as plain objects
// ({"k":"json",...} materializes fresh, never an Error instance) and are
// converted into real Error instances carrying a Node-style .code here.
export const javascriptFsFacade = `(() => {
  "use strict";
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function bytesToBase64(bytes) {
    let result = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
      result += B64[(triplet >> 18) & 63];
      result += B64[(triplet >> 12) & 63];
      result += i + 1 < bytes.length ? B64[(triplet >> 6) & 63] : "=";
      result += i + 2 < bytes.length ? B64[triplet & 63] : "=";
    }
    return result;
  }
  function base64ToBytes(str) {
    const clean = str.replace(/=+$/, "");
    const bytes = [];
    let buffer = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
      const val = B64.indexOf(clean[i]);
      if (val === -1) continue;
      buffer = (buffer << 6) | val;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  }
  function callNative(fn, ...args) {
    try {
      return fn(...args);
    } catch (thrown) {
      if (thrown && typeof thrown === "object" && "code" in thrown) {
        const err = new Error(thrown.message);
        err.code = thrown.code;
        if (thrown.name) err.name = thrown.name;
        throw err;
      }
      throw thrown;
    }
  }

  function readFileSync(path, encoding) {
    const enc = typeof encoding === "object" && encoding ? encoding.encoding : encoding;
    const res = callNative(globalThis.__sandbox_fs_readFileSync, path, enc);
    if (res && typeof res === "object" && "text" in res) return res.text;
    return base64ToBytes(res.bytesBase64);
  }
  function writeFileSync(path, data) {
    if (typeof data === "string") return callNative(globalThis.__sandbox_fs_writeFileSync, path, "utf8", data);
    return callNative(globalThis.__sandbox_fs_writeFileSync, path, "base64", bytesToBase64(data));
  }
  function readdirSync(path, options) {
    const entries = callNative(globalThis.__sandbox_fs_readdirSync, path);
    if (options && options.withFileTypes) {
      return entries.map(({ name, type }) => ({
        name,
        isFile: () => type === "file",
        isDirectory: () => type === "directory",
      }));
    }
    return entries.map((e) => e.name);
  }
  function mkdirSync(path, options) {
    return callNative(globalThis.__sandbox_fs_mkdirSync, path, !!(options && options.recursive));
  }
  function rmSync(path, options) {
    const opts = options || {};
    return callNative(globalThis.__sandbox_fs_rmSync, path, !!opts.recursive, !!opts.force);
  }
  function renameSync(from, to) {
    return callNative(globalThis.__sandbox_fs_renameSync, from, to);
  }
  function existsSync(path) {
    try {
      return callNative(globalThis.__sandbox_fs_existsSync, path);
    } catch {
      return false;
    }
  }
  function statSync(path) {
    const info = callNative(globalThis.__sandbox_fs_statSync, path);
    return {
      size: info.size,
      mtimeMs: info.updatedAt,
      isFile: () => info.type === "file",
      isDirectory: () => info.type === "directory",
    };
  }

  globalThis.fs = {
    readFileSync,
    writeFileSync,
    readdirSync,
    mkdirSync,
    rmSync,
    renameSync,
    existsSync,
    statSync,
  };

  const cwd = () => callNative(globalThis.__sandbox_process_cwd);
  const chdir = (path) => {
    callNative(globalThis.__sandbox_process_chdir, path);
  };
  if (globalThis.process && typeof globalThis.process === "object") {
    globalThis.process.cwd = cwd;
    globalThis.process.chdir = chdir;
  } else {
    globalThis.process = { env: {}, cwd, chdir };
  }
})();`;
