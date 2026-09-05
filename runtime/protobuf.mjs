const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function varint(value) {
  let n = BigInt(value),
    bytes = [];
  do {
    let b = Number(n & 127n);
    n >>= 7n;
    bytes.push(b | (n ? 128 : 0));
  } while (n);
  return bytes;
}
export function message(fields) {
  const bytes = [];
  fields.forEach(([field, value]) => {
    if (typeof value === "string") {
      const data = encoder.encode(value);
      bytes.push(...varint(field * 8 + 2), ...varint(data.length));
      for (const b of data) bytes.push(b);
    } else bytes.push(...varint(field * 8), ...varint(value));
  });
  return Uint8Array.from(bytes);
}
function decode(data) {
  let i = 0;
  const result = {};
  function read() {
    let n = 0n,
      shift = 0n;
    while (i < data.length) {
      const b = data[i++];
      n |= BigInt(b & 127) << shift;
      if (!(b & 128)) return n;
      shift += 7n;
      if (shift > 63n) throw new Error("Invalid protobuf");
    }
    throw new Error("Truncated protobuf");
  }
  while (i < data.length) {
    const key = Number(read()),
      field = key >> 3;
    if ((key & 7) === 0) result[field] = read();
    else if ((key & 7) === 2) {
      const len = Number(read());
      if (i + len > data.length) throw new Error("Truncated protobuf field");
      result[field] = data.slice(i, i + len);
      i += len;
    } else throw new Error("Unsupported protobuf field");
  }
  return result;
}
export function invoke(instance, method, fields) {
  const e = instance.exports,
    input = message(fields),
    ptr = e.wasm_alloc(input.length);
  new Uint8Array(e.memory.buffer).set(input, ptr);
  const packed = e[method](ptr, input.length);
  e.wasm_free(ptr);
  const out = Number(packed >> 32n),
    len = Number(packed & 0xffffffffn);
  if (len > 131072) throw new Error("Interpreter response limit exceeded");
  const result = decode(new Uint8Array(e.memory.buffer, out, len));
  e.wasm_free(out);
  return result;
}
