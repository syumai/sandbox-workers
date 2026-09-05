import { createWasi, ExecutionLimitError, hasOpenGuestFds } from "./wasi.mjs";
import { memoryPageCount, writePage } from "./snapshot.mjs";
import { invoke } from "./protobuf.mjs";
import {
  javascriptPrelude,
  javascriptSessionPrelude,
  javascriptFsFacade,
} from "./javascript-prelude.mjs";
import {
  transformForAsyncExecution,
  transformForRepl,
} from "../packages/javascript/src/transform.mjs";
import { WorkspaceError } from "./workspace.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// js_new(32 MiB heap cap, 1 MiB stack quota): keeps GC allocation failures and
// runaway recursion catchable inside the guest instead of trapping the instance.
const MAX_HEAP_BYTES = 32 * 1024 * 1024;
const NATIVE_STACK_QUOTA_BYTES = 1 * 1024 * 1024;

// Method ids are alphabetical over js.h's exported names (see engine/README notes).
const JS_NEW = "w_0_24";
const JS_EVAL = "w_0_14";
const JS_GLOBAL = "w_0_20";
const JS_DEFINE_FUNCTION = "w_0_12";
const JS_INTERRUPT_ADDR = "w_0_21";
const JS_INTERRUPT_BITS_ADDR = "w_0_22";
const JS_INTERRUPT_BITS_VALUE = "w_0_23";

const INTERRUPTED_ERROR = "JS execution interrupted";

// Wasm-level fuel meter for the JS engine. Unlike the generic budget() in wasi.mjs
// (which throws the instant fuel runs out), this meter cannot throw as soon as it
// hits zero: SpiderMonkey's interrupt is a request, not a synchronous abort, and it
// is only observed at the JS bytecode interpreter's own periodic check. So once the
// budget is exhausted the meter instead writes the interrupt words (once) and lets
// the guest keep running until SpiderMonkey notices; a hard backstop throws
// ExecutionLimitError only if ticking continues for another full budget past zero,
// covering the case where the interrupt is never observed (e.g. a long single
// non-looping host call) so a request can never run forever.
function createMeter(fuel) {
  let limit = fuel;
  let remaining = fuel;
  let armed = null;
  let interrupted = false;
  return {
    tick() {
      remaining--;
      if (remaining > 0) return;
      if (!interrupted && armed) {
        interrupted = true;
        const view = new DataView(armed.memory.buffer);
        view.setUint32(armed.addr, 1, true);
        if (armed.bitsAddr !== 0)
          view.setUint32(
            armed.bitsAddr,
            view.getUint32(armed.bitsAddr, true) | armed.bits,
            true,
          );
      }
      if (remaining <= -limit) {
        // Unlike the clean, engine-observed interrupt above (SpiderMonkey
        // notices the interrupt request at its own bytecode check and
        // returns a structured error from js_eval), this backstop fires by
        // throwing straight out of a `sandbox.tick` import call while a Wasm
        // frame is still on the stack -- the call never returns normally, so
        // the shadow stack pointer is not guaranteed to be at rest. Tag the
        // error so callers (createJavaScriptSession's execute(), and the
        // session Durable Object) treat this like a trap: drop the instance,
        // never snapshot it.
        const error = new ExecutionLimitError("Execution fuel exhausted");
        error.trap = true;
        throw error;
      }
    },
    arm(memory, addr, bitsAddr, bits) {
      armed = { memory, addr, bitsAddr, bits };
    },
    // Sessions reuse one instance across many executions: reset the budget
    // (and clear any interrupt request left armed by a PRIOR execution) at
    // the start of each one, so a fuel exhaustion in call N doesn't bleed
    // into call N+1.
    reset(newFuel) {
      limit = newFuel;
      remaining = newFuel;
      interrupted = false;
      if (armed) {
        const view = new DataView(armed.memory.buffer);
        view.setUint32(armed.addr, 0, true);
        if (armed.bitsAddr !== 0)
          view.setUint32(armed.bitsAddr, view.getUint32(armed.bitsAddr, true) & ~armed.bits, true);
      }
    },
    interrupted() {
      return interrupted;
    },
    usage(memory) {
      return {
        fuelConsumed: limit - remaining,
        fuelLimit: limit,
        memoryBytes: memory.buffer.byteLength,
      };
    },
  };
}

function jsGlobal(instance, handle) {
  return invoke(instance, JS_GLOBAL, [[1, handle]])[1];
}

function defineHostFunction(instance, handle, globalHandle, name, key, nargs) {
  const nameBytes = encoder.encode(name);
  const keyBytes = encoder.encode(key);
  const raw = invoke(instance, JS_DEFINE_FUNCTION, [
    [1, handle],
    [2, globalHandle],
    [3, name],
    [4, nameBytes.length],
    [5, key],
    [6, keyBytes.length],
    [7, nargs],
  ])[1];
  const envelope = JSON.parse(decoder.decode(raw));
  if (!envelope.ok) throw new Error(`js_define_function(${name}) failed: ${envelope.error}`);
}

// Bridges the engine's env.go_host_call/env.go_host_result imports (see the
// "Verified facts" notes in the session design doc) to a map of handler
// functions keyed by the dispatch key each was registered under. A handler
// receives the call's decoded arguments (plain strings/numbers/booleans —
// this sandbox never needs an object/function handle argument) and returns
// {tag, payload}: 'R' + a value-encoding-JSON payload is returned to the
// guest, 'T' + one is thrown as that value (a plain object, never an Error
// instance — the fs facade upgrades it to a real Error with .code), 'E' +
// a raw message is thrown as a JS Error. The module loader's raw-bytes reply
// is just another {tag: "R", payload: <raw source bytes>}.
function makeHostBridge(getInstance, handlers) {
  let pending = null;
  function decodeArg(encoding) {
    switch (encoding.k) {
      case "string":
      case "number":
      case "bool":
        return encoding.v;
      case "undefined":
        return undefined;
      case "null":
        return null;
      default:
        throw new Error(`Unsupported host-call argument kind: ${encoding.k}`);
    }
  }
  return {
    go_host_call(keyPtr, keyLen, argsPtr, argsLen, thisId, outPtr, outCap) {
      const instance = getInstance();
      const mem = new Uint8Array(instance.exports.memory.buffer);
      const key = decoder.decode(mem.subarray(keyPtr, keyPtr + keyLen));
      const handler = handlers.get(key);
      if (!handler) return 0;
      let reply;
      try {
        const argsJson = decoder.decode(mem.subarray(argsPtr, argsPtr + argsLen));
        const rawArgs = JSON.parse(argsJson);
        // The reserved module-loader key is called by the engine itself with
        // plain strings ([specifier, referrer]), not value-encoded args like
        // every js_define_function-registered call (verified empirically:
        // args arrive as `["lib.mjs", ""]`, not `[{"k":"string","v":...}]`).
        const args = key === "\0module-load" ? rawArgs : rawArgs.map(decodeArg);
        reply = handler(args, thisId);
      } catch (error) {
        reply = { tag: "E", payload: encoder.encode(String(error?.message ?? error)) };
      }
      const tagByte = reply.tag.charCodeAt(0);
      const total = 1 + reply.payload.length;
      if (total <= outCap) {
        const view = new Uint8Array(getInstance().exports.memory.buffer);
        view[outPtr] = tagByte;
        view.set(reply.payload, outPtr + 1);
        pending = null;
      } else {
        pending = new Uint8Array(total);
        pending[0] = tagByte;
        pending.set(reply.payload, 1);
      }
      return total;
    },
    go_host_result(outPtr) {
      if (!pending) return;
      new Uint8Array(getInstance().exports.memory.buffer).set(pending, outPtr);
      pending = null;
    },
  };
}

const jsonReply = (tag, value) => ({
  tag,
  payload: encoder.encode(JSON.stringify({ k: "json", v: value })),
});

// fs/process host functions, all backed by the shared session Workspace.
// `getCwd`/`setCwd` close over the session's mutable cwd (the single source
// of truth; process.cwd() always reads it live, so it can never drift from
// what fs paths resolve relative to).
function makeSessionHandlers(workspace, getCwd, setCwd, onCwdChange) {
  const wrap = (fn) => (args) => {
    try {
      return jsonReply("R", fn(args) ?? null);
    } catch (error) {
      const isWorkspaceError = error instanceof WorkspaceError;
      return jsonReply("T", {
        name: isWorkspaceError ? "Error" : String(error?.name ?? "Error"),
        message: String(error?.message ?? error),
        code: isWorkspaceError ? error.code : undefined,
      });
    }
  };
  return new Map([
    [
      "fs.readFileSync",
      wrap(([path, encoding]) => {
        const wantsText = encoding === "utf8" || encoding === "utf-8";
        const result = workspace.read(path, getCwd(), {
          encoding: wantsText ? "utf-8" : "base64",
        });
        return wantsText ? { text: result.content } : { bytesBase64: result.content };
      }),
    ],
    [
      "fs.writeFileSync",
      wrap(([path, encoding, content]) => {
        workspace.write(path, getCwd(), content, {
          encoding: encoding === "utf8" ? "utf-8" : "base64",
        });
      }),
    ],
    [
      "fs.readdirSync",
      wrap(([path]) => {
        const { entries } = workspace.list(path, getCwd());
        return entries.map((entry) => ({ name: entry.path.split("/").at(-1), type: entry.type }));
      }),
    ],
    [
      "fs.mkdirSync",
      wrap(([path, recursive]) => {
        workspace.mkdir(path, getCwd(), { recursive: !!recursive });
      }),
    ],
    [
      "fs.rmSync",
      wrap(([path, recursive, force]) => {
        workspace.delete(path, getCwd(), { recursive: !!recursive, force: !!force });
      }),
    ],
    [
      "fs.renameSync",
      wrap(([from, to]) => {
        workspace.rename(from, to, getCwd());
      }),
    ],
    ["fs.existsSync", wrap(([path]) => workspace.exists(path, getCwd()).exists)],
    ["fs.statSync", wrap(([path]) => workspace.stat(path, getCwd()))],
    ["process.cwd", wrap(() => getCwd())],
    [
      "process.chdir",
      wrap(([path]) => {
        const info = workspace.stat(path, getCwd());
        if (info.type !== "directory") throw new WorkspaceError("ENOTDIR", `Not a directory: ${path}`);
        const { absolute } = workspace.normalize(path, getCwd());
        setCwd(absolute);
        onCwdChange?.(absolute);
      }),
    ],
    [
      "\0module-load",
      ([specifier, referrer]) => {
        const result = workspace.moduleSource(specifier, referrer);
        if (!result.ok)
          return { tag: "E", payload: encoder.encode(`module not registered: ${specifier}`) };
        return { tag: "R", payload: result.source };
      },
    ],
  ]);
}

const HOST_FUNCTIONS = [
  ["__sandbox_fs_readFileSync", "fs.readFileSync", 2],
  ["__sandbox_fs_writeFileSync", "fs.writeFileSync", 3],
  ["__sandbox_fs_readdirSync", "fs.readdirSync", 1],
  ["__sandbox_fs_mkdirSync", "fs.mkdirSync", 2],
  ["__sandbox_fs_rmSync", "fs.rmSync", 3],
  ["__sandbox_fs_renameSync", "fs.renameSync", 2],
  ["__sandbox_fs_existsSync", "fs.existsSync", 1],
  ["__sandbox_fs_statSync", "fs.statSync", 1],
  ["__sandbox_process_cwd", "process.cwd", 0],
  ["__sandbox_process_chdir", "process.chdir", 1],
];

// Parses the raw js_eval envelope error text ("TypeError: msg\n@<eval>:1:5\n
// ...", or just a bare message for a non-Error thrown value with no stack)
// into the {name, message, traceback} shape used everywhere else. Only
// needed for REPL mode: user code is handed to js_eval directly (not through
// __sandbox.execute()'s own try/catch), so a synchronous throw surfaces
// through js_eval's own ok/error fields instead of our JSON envelope.
function parseEngineError(text) {
  const lines = String(text).split("\n");
  const first = lines[0] ?? String(text);
  const match = /^(\S+): ([\s\S]*)$/.exec(first);
  return {
    name: match ? match[1] : "Error",
    message: match ? match[2] : first,
    traceback: lines.slice(1),
  };
}

function randomGetOverride(getInstance) {
  // See the comment on this override in runJavaScript: memory is shared, so
  // crypto.getRandomValues() must fill a plain scratch buffer and be copied
  // in, rather than being handed a shared-memory view directly.
  return (ptr, len) => {
    const memory = new Uint8Array(getInstance().exports.memory.buffer);
    for (let offset = 0; offset < len; ) {
      const chunk = Math.min(65536, len - offset);
      const tmp = new Uint8Array(chunk);
      crypto.getRandomValues(tmp);
      memory.set(tmp, ptr + offset);
      offset += chunk;
    }
    return 0;
  };
}

function jsEval(instance, handle, src) {
  const bytes = encoder.encode(src);
  const raw = invoke(instance, JS_EVAL, [
    [1, handle],
    [2, src],
    [3, bytes.length],
  ])[1];
  return JSON.parse(decoder.decode(raw));
}

// Decode a js.h "value encoding" JSON string. Only strings and undefined are ever
// read here: __sandbox.execute()/take() only ever hand back a JSON string (or
// undefined, when the guest's async body never settled).
function decodeValueEncoding(field) {
  const encoding = JSON.parse(field);
  if (encoding.k === "undefined") return undefined;
  if (encoding.k === "string") return encoding.v;
  throw new Error(`Unexpected __sandbox value encoding: ${encoding.k}`);
}

function checkInterrupted(envelope) {
  if (envelope.ok) return;
  if (envelope.error === INTERRUPTED_ERROR)
    throw new ExecutionLimitError("Execution fuel exhausted");
  throw new Error(`JavaScript engine error: ${envelope.error}`);
}

export function runJavaScript(module, payload) {
  const fuel = 50_000_000;
  const meter = createMeter(fuel);
  const host = createWasi(module, null, meter);

  // wasi.thread-spawn: helper threads are optional here (pthread_create failing
  // with EAGAIN just disables them); env.go_host_call/go_host_result back the
  // module-loader and host-function-call bridges, unused by this sandbox (no ES
  // modules, no host-defined JS functions are registered).
  (host.imports.wasi ??= {})["thread-spawn"] = () => -1;
  Object.assign((host.imports.env ??= {}), {
    go_host_call: () => 0,
    go_host_result: () => {},
  });

  // @bjorn3/browser_wasi_shim's random_get silently falls back to Math.random()
  // when the instance memory is backed by a SharedArrayBuffer, because
  // crypto.getRandomValues() refuses SharedArrayBuffer-backed views. This engine's
  // memory is declared shared (for the never-enabled thread-spawn path), so without
  // this override every random_get call would go through Math.random() instead of
  // real entropy. Fill a plain (non-shared) scratch buffer with crypto randomness
  // and copy it into the shared memory instead.
  let instance;
  host.imports.wasi_snapshot_preview1.random_get = (ptr, len) => {
    const memory = new Uint8Array(instance.exports.memory.buffer);
    for (let offset = 0; offset < len; ) {
      const chunk = Math.min(65536, len - offset);
      const tmp = new Uint8Array(chunk);
      crypto.getRandomValues(tmp);
      memory.set(tmp, ptr + offset);
      offset += chunk;
    }
    return 0;
  };

  instance = new WebAssembly.Instance(module, host.imports);
  host.wasi.initialize(instance);
  instance.exports.wasm_init();

  const handle = invoke(instance, JS_NEW, [
    [1, MAX_HEAP_BYTES],
    [2, NATIVE_STACK_QUOTA_BYTES],
  ])[1];
  if (!handle) throw new Error("JavaScript engine initialization failed");

  const addr = Number(invoke(instance, JS_INTERRUPT_ADDR, [[1, handle]])[1]);
  const bitsAddr = Number(
    invoke(instance, JS_INTERRUPT_BITS_ADDR, [[1, handle]])[1],
  );
  const bits = Number(
    invoke(instance, JS_INTERRUPT_BITS_VALUE, [[1, handle]])[1],
  );
  meter.arm(instance.exports.memory, addr, bitsAddr, bits);

  const boot = jsEval(instance, handle, javascriptPrelude);
  if (!boot.ok)
    throw new Error(`JavaScript sandbox initialization failed: ${boot.error}`);

  // The host-side transform turns the script into an async IIFE whose value is
  // the last top-level expression (or a guest SyntaxError for a top-level
  // `return`); the guest evaluates that IIFE text directly instead of building
  // an AsyncFunction with an `input` parameter.
  const transformed = transformForAsyncExecution(payload.code);
  const execSrc = `__sandbox.execute(${JSON.stringify(transformed)}, ${JSON.stringify(
    JSON.stringify(payload.envVars ?? {}),
  )});`;
  const execEnvelope = jsEval(instance, handle, execSrc);
  checkInterrupted(execEnvelope);

  const takeEnvelope = jsEval(instance, handle, "__sandbox.take();");
  checkInterrupted(takeEnvelope);

  const decoded = decodeValueEncoding(takeEnvelope.result);
  if (decoded === undefined)
    return {
      logs: { stdout: [], stderr: [] },
      results: [],
      error: {
        name: "Error",
        message:
          "Execution did not complete: a promise never settled (timers and indefinitely pending promises are unsupported)",
        traceback: [],
      },
      usage: meter.usage(instance.exports.memory),
    };

  // The guest's own try/catch (in __sandbox.execute) already reports console
  // and result limits as a regular `error: {name: "ExecutionLimitError", ...}`
  // entry, so no special-casing is needed here: only an engine-level interrupt
  // (checked above) or the hard fuel backstop (thrown from meter.tick() through
  // the wasm import boundary) escape as a thrown ExecutionLimitError.
  const final = JSON.parse(decoded);
  return {
    logs: final.logs,
    results: final.results,
    ...(final.error ? { error: final.error } : {}),
    usage: meter.usage(instance.exports.memory),
  };
}

// Shared host wiring for a durable JS session, used by both a fresh boot
// (createJavaScriptSession) and a snapshot restore (restoreJavaScriptSession):
// the fuel meter, the WASI host (with /workspace mounted when present), and
// the go_host_call/go_host_result bridge to fs/process handlers backed by
// `workspace`. The instance itself doesn't exist yet when this runs, so the
// bridge and random_get override close over a mutable box the caller fills
// in right after `new WebAssembly.Instance(...)`.
function createSessionHost(module, workspace, getCwd, setCwd, onCwdChange) {
  const fuel = 50_000_000;
  const meter = createMeter(fuel);
  const host = createWasi(module, null, meter, {}, workspace?.root ?? null);
  (host.imports.wasi ??= {})["thread-spawn"] = () => -1;

  const box = { instance: null };
  const getInstance = () => box.instance;
  const handlers = makeSessionHandlers(workspace, getCwd, setCwd, onCwdChange);
  const bridge = makeHostBridge(getInstance, handlers);
  Object.assign((host.imports.env ??= {}), {
    go_host_call: (...args) => bridge.go_host_call(...args),
    go_host_result: (...args) => bridge.go_host_result(...args),
  });
  host.imports.wasi_snapshot_preview1.random_get = randomGetOverride(getInstance);

  return { host, meter, fuel, box };
}

// The session object returned by both createJavaScriptSession and
// restoreJavaScriptSession, once each has finished setting up its own
// `instance`/`handle`/interrupt addresses. Declarations made by one
// execute() persist to the next because user code is handed to js_eval
// directly (see transformForRepl); fs/process are host functions backed by
// the shared `workspace`; import() is served from it too.
function buildSessionApi({ instance, handle, meter, fuel, host, workspace, getCwd, setCwd, onCwdChange, interrupt }) {
  let closed = false;
  return {
    get cwd() {
      return getCwd();
    },
    close() {
      closed = true;
    },
    // Snapshot rules (docs/sessions-design.md): never while the guest holds
    // an open file descriptor beyond the preopens. A trap (the hard fuel
    // backstop in createMeter, tagged `.trap`, or any other exception
    // escaping execute() uncaught) is not checked here because the caller
    // (the session Durable Object) drops the instance outright in that case
    // -- there is no live session left to ask.
    canSnapshot() {
      return !closed && !hasOpenGuestFds(host);
    },
    // { handle, extra, memory }: `memory` is exposed directly (a
    // WebAssembly.Memory, backed by a SharedArrayBuffer for this engine) so
    // the caller can hash/copy pages with runtime/snapshot.mjs without this
    // module needing to know about the `pages` table or hashing at all.
    snapshot() {
      return {
        handle,
        extra: {
          interruptAddr: interrupt.addr,
          interruptBitsAddr: interrupt.bitsAddr,
          interruptBits: interrupt.bits,
        },
        memory: instance.exports.memory,
      };
    },
    execute(payload) {
      if (closed) throw new Error("This session instance has been closed");
      meter.reset(fuel);

      if (payload.cwd !== undefined && workspace) {
        try {
          const info = workspace.stat(payload.cwd, getCwd());
          if (info.type === "directory") {
            const absolute = workspace.normalize(payload.cwd, getCwd()).absolute;
            setCwd(absolute);
            onCwdChange?.(absolute);
          }
        } catch {
          // Invalid/missing cwd: keep the session's current cwd, matching
          // the WASI-language sessions' "reset to /workspace" leniency.
        }
      }

      const resetEnvelope = jsEval(
        instance,
        handle,
        `__sandboxSession.reset(${JSON.stringify(JSON.stringify(payload.envVars ?? {}))});`,
      );
      checkInterrupted(resetEnvelope);

      const transform = transformForRepl(payload.code);
      const runEnvelope = jsEval(instance, handle, transform.code);
      if (!runEnvelope.ok) {
        if (runEnvelope.error === INTERRUPTED_ERROR)
          throw new ExecutionLimitError("Execution fuel exhausted");
        return {
          logs: { stdout: [], stderr: [] },
          results: [],
          error: parseEngineError(runEnvelope.error),
          session: { cwd: getCwd() },
          usage: meter.usage(instance.exports.memory),
        };
      }

      const endEnvelope = jsEval(
        instance,
        handle,
        `__sandboxSession.end(${transform.mode === "hoist" ? "true" : "false"});`,
      );
      checkInterrupted(endEnvelope);
      const decoded = decodeValueEncoding(endEnvelope.result);
      const final = JSON.parse(decoded);
      return {
        logs: final.logs,
        results: final.results,
        ...(final.error ? { error: final.error } : {}),
        session: { cwd: getCwd() },
        usage: meter.usage(instance.exports.memory),
      };
    },
  };
}

// A durable session: one JS engine instance kept alive in memory across many
// execute() calls, and snapshottable to a Durable Object's `pages` table via
// .snapshot()/.canSnapshot() (see runtime/snapshot.mjs and runtime/session.mjs).
export function createJavaScriptSession(module, options = {}) {
  const workspace = options.workspace ?? null;
  let cwd = options.cwd ?? "/workspace";
  const onCwdChange = options.onCwdChange;
  const getCwd = () => cwd;
  const setCwd = (next) => {
    cwd = next;
  };
  const { host, meter, fuel, box } = createSessionHost(module, workspace, getCwd, setCwd, onCwdChange);

  const instance = new WebAssembly.Instance(module, host.imports);
  box.instance = instance;
  host.wasi.initialize(instance);
  instance.exports.wasm_init();

  const handle = invoke(instance, JS_NEW, [
    [1, MAX_HEAP_BYTES],
    [2, NATIVE_STACK_QUOTA_BYTES],
  ])[1];
  if (!handle) throw new Error("JavaScript engine initialization failed");

  const addr = Number(invoke(instance, JS_INTERRUPT_ADDR, [[1, handle]])[1]);
  const bitsAddr = Number(invoke(instance, JS_INTERRUPT_BITS_ADDR, [[1, handle]])[1]);
  const bits = Number(invoke(instance, JS_INTERRUPT_BITS_VALUE, [[1, handle]])[1]);
  meter.arm(instance.exports.memory, addr, bitsAddr, bits);

  const boot = jsEval(instance, handle, javascriptPrelude);
  if (!boot.ok)
    throw new Error(`JavaScript session initialization failed: ${boot.error}`);
  const bootSession = jsEval(instance, handle, javascriptSessionPrelude);
  if (!bootSession.ok)
    throw new Error(`JavaScript session initialization failed: ${bootSession.error}`);

  if (workspace) {
    const globalHandle = jsGlobal(instance, handle);
    for (const [name, key, nargs] of HOST_FUNCTIONS)
      defineHostFunction(instance, handle, globalHandle, name, key, nargs);
    const facade = jsEval(instance, handle, javascriptFsFacade);
    if (!facade.ok)
      throw new Error(`JavaScript session initialization failed: ${facade.error}`);
  }

  return buildSessionApi({
    instance,
    handle,
    meter,
    fuel,
    host,
    workspace,
    getCwd,
    setCwd,
    onCwdChange,
    interrupt: { addr, bitsAddr, bits },
  });
}

// Restores a session from a previous .snapshot() (see runtime/session.mjs):
// instantiates fresh, then -- per docs/sessions-design.md's verified restore
// recipe -- points wasi.inst at the instance directly (no wasi.initialize(),
// no _initialize, no wasm_init()), grows memory to the snapshot's page count,
// copies its non-zero pages back in, and reuses the stored interpreter
// handle and interrupt addresses instead of re-deriving them. Guest-defined
// host-function stubs (js_define_function) already live in the restored
// memory; only the host-side dispatch map is rebuilt (by createSessionHost
// above, with the same dispatch keys), so the prelude, session prelude, and
// js_define_function calls are not re-run.
//
// `options.snapshot` is `{ handle, extra, memoryPages, readPage }`, where
// `readPage(page)` returns that page's stored bytes (a Uint8Array) or
// undefined for a page with no row (meaning it was all-zero when the
// snapshot was taken -- a freshly grown WebAssembly.Memory is already
// zero-filled, so there is nothing to write).
export function restoreJavaScriptSession(module, options = {}) {
  const workspace = options.workspace ?? null;
  let cwd = options.cwd ?? "/workspace";
  const onCwdChange = options.onCwdChange;
  const getCwd = () => cwd;
  const setCwd = (next) => {
    cwd = next;
  };
  const { host, meter, fuel, box } = createSessionHost(module, workspace, getCwd, setCwd, onCwdChange);

  const instance = new WebAssembly.Instance(module, host.imports);
  box.instance = instance;
  host.wasi.inst = instance;

  const { handle, extra, memoryPages, readPage: readSnapshotPage } = options.snapshot;
  const currentPages = memoryPageCount(instance.exports.memory);
  if (memoryPages > currentPages) instance.exports.memory.grow(memoryPages - currentPages);
  for (let page = 0; page < memoryPages; page++) {
    const data = readSnapshotPage(page);
    if (data) writePage(instance.exports.memory, page, data);
  }

  meter.arm(instance.exports.memory, extra.interruptAddr, extra.interruptBitsAddr, extra.interruptBits);

  return buildSessionApi({
    instance,
    handle,
    meter,
    fuel,
    host,
    workspace,
    getCwd,
    setCwd,
    onCwdChange,
    interrupt: { addr: extra.interruptAddr, bitsAddr: extra.interruptBitsAddr, bits: extra.interruptBits },
  });
}

export { ExecutionLimitError };
