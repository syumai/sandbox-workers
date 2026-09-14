import { RubyVM } from "@ruby/wasm-wasi";
import { createWasi, budget, ExecutionLimitError } from "@sandbox-workers/interpreter/wasi";
const encoder = new TextEncoder();
// Hex-encodes the code so it can be embedded as a Ruby string literal
// without worrying about quoting/escaping; the driver script decodes it
// with `["<hex>"].pack("H*")` before handing it to `eval`.
const hex = (value) =>
  Array.from(encoder.encode(value), (b) => b.toString(16).padStart(2, "0")).join("");
// RubyVM initialization is asynchronous; serialize it so two guest memories
// cannot be live concurrently within one Worker isolate.
let pending = Promise.resolve();
export function runRuby(module, payload, limits) {
  const result = pending.then(() => execute(module, payload, limits));
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}
async function execute(module, payload, limits) {
  const meter = budget(limits.fuel),
    host = createWasi(module, null, meter, payload.envVars ?? {}),
    vm = new RubyVM();
  vm.addToImports(host.imports);
  // Ruby's JS bridge otherwise exposes the Worker global, eval, and fetch.
  for (const name of Object.keys(host.imports["rb-js-abi-host"]))
    host.imports["rb-js-abi-host"][name] = () => {
      throw new Error("JavaScript host access is disabled");
    };
  const instance = new WebAssembly.Instance(module, host.imports);
  await vm.setInstance(instance);
  host.wasi.initialize(instance);
  vm.initialize();
  const script = `require 'json'
# ENV always re-queries the OS and tags values as ASCII-8BIT (BINARY), which
# makes JSON.generate warn even when the bytes are valid UTF-8. Swap in a
# plain Hash of the same entries, correctly tagged, before running the code.
__sandbox_env = {}
ENV.each { |k, v| __sandbox_env[k] = v.dup.force_encoding("UTF-8") }
Object.send(:remove_const, :ENV)
ENV = __sandbox_env
begin
  __sandbox_source = ["${hex(payload.code)}"].pack("H*").force_encoding("UTF-8")
  __sandbox_value = eval(__sandbox_source, TOPLEVEL_BINDING.dup, "(sandbox)", 1)
  if __sandbox_value.nil?
    __sandbox_results = []
  elsif __sandbox_value.is_a?(Hash) || __sandbox_value.is_a?(Array)
    begin
      JSON.generate(__sandbox_value)
      __sandbox_results = [{ json: __sandbox_value }]
    rescue Exception
      __sandbox_results = [{ text: __sandbox_value.inspect }]
    end
  else
    __sandbox_results = [{ text: __sandbox_value.inspect }]
  end
  __sandbox_envelope = { results: __sandbox_results, error: nil }
rescue Exception => __sandbox_error
  __sandbox_envelope = { results: [], error: { name: __sandbox_error.class.name, message: __sandbox_error.message, traceback: __sandbox_error.backtrace || [] } }
end
JSON.generate(__sandbox_envelope)`;
  let raw;
  try {
    raw = vm.eval(script).toString();
  } catch (error) {
    // A jump (`return`, `break`, `next`, ...) that escapes past the top of
    // this `vm.eval()` call is a raw VM tag-unwind, not a Ruby exception, so
    // it is never seen by the script's own `rescue Exception` no matter how
    // deeply the user's `return` is nested inside it. Real MRI converts an
    // escaping return into a rescuable LocalJumpError at the top of a script
    // or method call; ruby.wasm's `eval` binding does not, so do the
    // equivalent conversion here instead of letting the request crash.
    // Anything else (fuel exhaustion, the disabled-JS-bridge guard, a
    // genuine engine crash) is not this specific, well-understood case, so
    // it keeps propagating exactly as before.
    const message = error instanceof Error ? error.message : String(error);
    if (!/^unexpected (return|break|next|redo|retry)\b/.test(message))
      throw error;
    return {
      logs: host.logs,
      results: [],
      error: { name: "LocalJumpError", message, traceback: [] },
      usage: meter.usage(instance.exports.memory),
    };
  }
  if (new TextEncoder().encode(raw).length > 65536)
    throw new ExecutionLimitError("Result limit exceeded");
  const envelope = JSON.parse(raw);
  return {
    logs: host.logs,
    results: envelope.results,
    ...(envelope.error ? { error: envelope.error } : {}),
    usage: meter.usage(instance.exports.memory),
  };
}
