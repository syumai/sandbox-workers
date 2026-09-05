import { createWasi, ExecutionLimitError } from "./wasi.mjs";
import { invoke } from "./protobuf.mjs";
import { javascriptPrelude } from "./javascript-prelude.mjs";
import { transformForAsyncExecution } from "../packages/javascript/src/transform.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// js_new(32 MiB heap cap, 1 MiB stack quota): keeps GC allocation failures and
// runaway recursion catchable inside the guest instead of trapping the instance.
const MAX_HEAP_BYTES = 32 * 1024 * 1024;
const NATIVE_STACK_QUOTA_BYTES = 1 * 1024 * 1024;

// Method ids are alphabetical over js.h's exported names (see engine/README notes).
const JS_NEW = "w_0_24";
const JS_EVAL = "w_0_14";
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
      if (remaining <= -fuel)
        throw new ExecutionLimitError("Execution fuel exhausted");
    },
    arm(memory, addr, bitsAddr, bits) {
      armed = { memory, addr, bitsAddr, bits };
    },
    interrupted() {
      return interrupted;
    },
    usage(memory) {
      return {
        fuelConsumed: fuel - remaining,
        fuelLimit: fuel,
        memoryBytes: memory.buffer.byteLength,
      };
    },
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

  const checkInterrupted = (envelope) => {
    if (envelope.ok) return;
    if (envelope.error === INTERRUPTED_ERROR)
      throw new ExecutionLimitError("Execution fuel exhausted");
    throw new Error(`JavaScript engine error: ${envelope.error}`);
  };

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

export { ExecutionLimitError };
