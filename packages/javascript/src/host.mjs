const encoder = new TextEncoder();
const decoder = new TextDecoder();
export class ExecutionLimitError extends Error {}
export function runEngine(module, payload, fuel = 5_000_000) {
  if (
    !WebAssembly.Module.imports(module).some(
      (i) => i.module === "sandbox" && i.name === "tick",
    )
  )
    throw new Error("Refusing to execute an unmetered engine");
  let instance;
  let remaining = fuel;
  let nextHandle = 10;
  let output;
  let diagnostic = "";
  const bodies = new Map([[2, encoder.encode(JSON.stringify(payload))]]);
  const view = () => new DataView(instance.exports.memory.buffer);
  const bytes = () => new Uint8Array(instance.exports.memory.buffer);
  const put32 = (p, n) => {
    view().setUint32(p, n, true);
    return 0;
  };
  const put64 = (p, n) => {
    view().setBigUint64(p, BigInt.asUintN(64, BigInt(n)), true);
    return 0;
  };
  const copy = (value, p, cap, written) => {
    if (value.length > cap) return 4;
    bytes().set(value, p);
    return put32(written, value.length);
  };
  const emptyHeaders = (_h, _p, _cap, _cursor, end, written) => {
    put64(end, -1);
    return put32(written, 0);
  };
  const imports = {};
  // Deny every capability unless implemented below. No host network, disk or secrets.
  for (const { module: ns, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind !== "function")
      throw new Error(`Unsupported import ${ns}.${name}`);
    (imports[ns] ??= {})[name] = () => {
      throw new Error(`Unsupported host capability: ${ns}.${name}`);
    };
  }
  const bind = (ns, methods) => Object.assign((imports[ns] ??= {}), methods);
  bind("sandbox", {
    tick() {
      if (--remaining < 0)
        throw new ExecutionLimitError("Execution fuel exhausted");
    },
  });
  bind("wasi_snapshot_preview1", {
    random_get(p, len) {
      for (let i = 0; i < len; i += 65536)
        crypto.getRandomValues(
          bytes().subarray(p + i, p + Math.min(len, i + 65536)),
        );
      return 0;
    },
    clock_time_get(_id, _precision, p) {
      return put64(p, BigInt(Date.now()) * 1000000n);
    },
    clock_res_get(_id, p) {
      return put64(p, 1000000);
    },
    environ_sizes_get(a, b) {
      put32(a, 0);
      return put32(b, 0);
    },
    environ_get() {
      return 0;
    },
    args_sizes_get(a, b) {
      put32(a, 0);
      return put32(b, 0);
    },
    args_get() {
      return 0;
    },
    fd_write(_fd, iov, count, written) {
      let total = 0;
      for (let i = 0; i < count; i++) {
        const p = view().getUint32(iov + i * 8, true),
          n = view().getUint32(iov + i * 8 + 4, true);
        if (diagnostic.length + n > 32768)
          throw new ExecutionLimitError("Diagnostic output limit exceeded");
        diagnostic += decoder.decode(bytes().subarray(p, p + n));
        total += n;
      }
      return put32(written, total);
    },
    fd_fdstat_get(_fd, p) {
      bytes().fill(0, p, p + 24);
      bytes()[p] = 2;
      return 0;
    },
    fd_close() {
      return 0;
    },
    fd_prestat_get() {
      return 8;
    },
    proc_exit(code) {
      if (code !== 0) throw new Error(`Engine exited ${code}: ${diagnostic}`);
      throw new EngineExit();
    },
  });
  bind("fastly_http_req", {
    body_downstream_get(req, body) {
      put32(req, 1);
      return put32(body, 2);
    },
    method_get(_h, p, cap, written) {
      return copy(encoder.encode("POST"), p, cap, written);
    },
    uri_get(_h, p, cap, written) {
      return copy(
        encoder.encode("https://sandbox.internal/execute"),
        p,
        cap,
        written,
      );
    },
    version_get(_h, p) {
      return put32(p, 2);
    },
    header_names_get: emptyHeaders,
    header_values_get(_h, _n, _nl, _p, _cap, _cur, end, written) {
      put64(end, -1);
      return put32(written, 0);
    },
  });
  bind("fastly_http_body", {
    new(p) {
      const h = nextHandle++;
      bodies.set(h, new Uint8Array());
      return put32(p, h);
    },
    read(h, p, cap, written) {
      const body = bodies.get(h);
      if (!body) return 3;
      const part = body.subarray(0, cap);
      const result = copy(part, p, cap, written);
      bodies.set(h, body.slice(part.length));
      return result;
    },
    write(h, p, len, end, written) {
      const old = bodies.get(h);
      if (!old) return 3;
      if (old.length + len > 131072)
        throw new ExecutionLimitError("Result exceeds 128 KiB");
      const part = bytes().slice(p, p + len),
        joined = new Uint8Array(old.length + len);
      if (end === 0) {
        joined.set(old);
        joined.set(part, old.length);
      } else {
        joined.set(part);
        joined.set(old, len);
      }
      bodies.set(h, joined);
      return put32(written, len);
    },
    known_length(h, p) {
      return put64(p, bodies.get(h)?.length ?? 0);
    },
    close() {
      return 0;
    },
    abandon() {
      return 0;
    },
  });
  bind("fastly_http_resp", {
    new(p) {
      return put32(p, nextHandle++);
    },
    status_set() {
      return 0;
    },
    status_get(_h, p) {
      view().setUint16(p, 200, true);
      return 0;
    },
    header_insert() {
      return 0;
    },
    header_append() {
      return 0;
    },
    framing_headers_mode_set() {
      return 0;
    },
    send_downstream(_h, body) {
      output = decoder.decode(bodies.get(body));
      return 0;
    },
  });
  bind("fastly_async_io", {
    is_ready(_h, p) {
      return put32(p, 1);
    },
    select(_h, _len, _timeout, p) {
      return put32(p, 0);
    },
  });
  instance = new WebAssembly.Instance(module, imports);
  try {
    instance.exports._start();
  } catch (e) {
    if (!(e instanceof EngineExit)) throw e;
  }
  if (output === undefined)
    throw new Error(`Engine returned no response: ${diagnostic}`);
  return {
    ...JSON.parse(output),
    usage: {
      fuelConsumed: fuel - remaining,
      fuelLimit: fuel,
      memoryBytes: instance.exports.memory.buffer.byteLength,
    },
  };
}
class EngineExit extends Error {}
