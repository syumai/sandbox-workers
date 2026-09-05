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
