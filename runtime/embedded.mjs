import { createWasi, budget, ExecutionLimitError } from "./wasi.mjs";
import { invoke } from "./protobuf.mjs";
const decode = (bytes) => new TextDecoder().decode(bytes);
const hex = (value) =>
  Array.from(new TextEncoder().encode(JSON.stringify(value ?? null)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export function runEmbedded(module, archive, language, payload) {
  const meter = budget(language === "perl" ? 10_000_000 : 100_000_000),
    host = createWasi(module, archive, meter);
  const instance = new WebAssembly.Instance(module, host.imports);
  host.wasi.initialize(instance);
  instance.exports.wasm_init();
  const handle = invoke(instance, language === "python" ? "w_0_5" : "w_0_16", [
    [1, "/stdlib"],
  ])[1];
  if (!handle) throw new Error("Interpreter initialization failed");
  let result;
  if (language === "python") {
    const evaluate = (code) => {
      const out = JSON.parse(
        decode(
          invoke(instance, "w_0_2", [
            [1, handle],
            [2, code],
          ])[1],
        ),
      );
      if (out.stdout) host.capture("log", out.stdout);
      if (out.stderr) host.capture("error", out.stderr);
      if (!out.ok) throw new Error(out.error || "Python execution failed");
      return out.repr;
    };
    const source = `def __sandbox_main(input):\n${payload.code
      .split("\n")
      .map((line) => "    " + line)
      .join("\n")}`;
    evaluate(
      `import json as __sandbox_json\ntry:\n    exec(__sandbox_json.loads(bytes.fromhex('${hex(source)}')))\n    __sandbox_value = {"ok": True, "result": __sandbox_main(__sandbox_json.loads(bytes.fromhex('${hex(payload.input)}')))}\n    __sandbox_result = __sandbox_json.dumps(__sandbox_value, allow_nan=False)\nexcept BaseException as __sandbox_error:\n    __sandbox_result = __sandbox_json.dumps({"ok": False, "error": str(__sandbox_error)})`,
    );
    const encoded = evaluate("__sandbox_result.encode('utf-8').hex()");
    if (!/^'[0-9a-f]*'$/.test(encoded))
      throw new Error("Invalid Python result");
    result = JSON.parse(
      decode(
        Uint8Array.from(encoded.slice(1, -1).match(/../g) ?? [], (b) =>
          parseInt(b, 16),
        ),
      ),
    );
    if (!result.ok) throw new Error(result.error);
    result = result.result;
  } else {
    const code = `use JSON::PP; my $input=JSON::PP::decode_json(pack('H*','${hex(payload.input)}')); my $result=(sub {\n${payload.code}\n})->(); JSON::PP->new->allow_nonref->utf8->encode($result);`;
    const bytes = invoke(instance, "w_0_8", [
      [1, handle],
      [2, code],
    ])[1];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const byte = () => view.getUint8(offset++);
    const string = () => {
      const n = view.getUint32(offset, true);
      offset += 4;
      const s = decode(bytes.subarray(offset, offset + n));
      offset += n;
      return s;
    };
    const status = byte();
    let error;
    if (status === 1) error = string();
    else if (status === 0) {
      const tag = byte();
      if (tag === 4) {
        byte();
        result = JSON.parse(string());
      } else if (tag === 2) {
        result = Number(view.getBigInt64(offset, true));
        offset += 8;
      } else if (tag === 3) {
        result = view.getFloat64(offset, true);
        offset += 8;
      } else throw new Error("Invalid Perl result");
    } else throw new Error("Perl exited without returning a result");
    const stdout = string(),
      stderr = string();
    if (stdout) host.capture("log", stdout);
    if (stderr) host.capture("error", stderr);
    if (error) throw new Error(error);
  }
  return {
    ok: true,
    result,
    logs: host.logs,
    usage: meter.usage(instance.exports.memory),
  };
}
export { ExecutionLimitError };
