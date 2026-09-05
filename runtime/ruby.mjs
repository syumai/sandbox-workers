import { RubyVM } from "@ruby/wasm-wasi";
import { createWasi, budget } from "./wasi.mjs";
// RubyVM initialization is asynchronous; serialize it so two guest memories
// cannot be live concurrently within one Worker isolate.
let pending = Promise.resolve();
export function runRuby(module, payload) {
  const result = pending.then(() => execute(module, payload));
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}
async function execute(module, payload) {
  const meter = budget(30_000_000),
    host = createWasi(module, null, meter),
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
  const input = Array.from(
    new TextEncoder().encode(JSON.stringify(payload.input ?? null)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const result = vm
    .eval(
      `require 'json'\nJSON.generate((->(input) {\n${payload.code}\n}).call(JSON.parse(['${input}'].pack('H*'))))`,
    )
    .toString();
  if (new TextEncoder().encode(result).length > 65536)
    throw new Error("Result limit exceeded");
  return {
    ok: true,
    result: JSON.parse(result),
    logs: host.logs,
    usage: meter.usage(instance.exports.memory),
  };
}
