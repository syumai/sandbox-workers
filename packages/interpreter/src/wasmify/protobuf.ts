// The minimal protobuf-subset ABI ("wasmify") the goccy spidermonkey-wasm,
// Python and Perl Wasm builds all expose: varint and length-delimited
// fields, just enough to call a `w_0_N` export and decode its response.
// TypeScript port of the pre-split, now-deleted protobuf.mjs, part of
// `@sandbox-workers/interpreter/wasmify`.
const encoder = new TextEncoder();

function varint(value: number | bigint): number[] {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    const b = Number(n & 127n);
    n >>= 7n;
    bytes.push(b | (n ? 128 : 0));
  } while (n);
  return bytes;
}

/** One field of a wasmify request message: `[fieldNumber, value]`. */
export type MessageField = [number, string | number | bigint];

export function message(fields: MessageField[]): Uint8Array {
  const bytes: number[] = [];
  fields.forEach(([field, value]) => {
    if (typeof value === "string") {
      const data = encoder.encode(value);
      bytes.push(...varint(field * 8 + 2), ...varint(data.length));
      for (const b of data) bytes.push(b);
    } else bytes.push(...varint(field * 8), ...varint(value));
  });
  return Uint8Array.from(bytes);
}

/** A decoded wasmify response message: field number -> varint (bigint) or length-delimited bytes. */
export type DecodedMessage = Record<number, bigint | Uint8Array>;

function decode(data: Uint8Array): DecodedMessage {
  let i = 0;
  const result: DecodedMessage = {};
  function read(): bigint {
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

/**
 * Calls Wasm export `method` (a wasmify method id, e.g. `"w_0_5"`) with
 * `fields` as its request message, and decodes the response message.
 * `instance.exports` is accessed loosely (`any`): the wasmify ABI's exported
 * function names/shapes are dynamic per engine build, not something a
 * static type usefully constrains here.
 */
export function invoke(instance: WebAssembly.Instance, method: string, fields: MessageField[]): DecodedMessage {
  const e = instance.exports as any;
  const input = message(fields);
  const ptr = e.wasm_alloc(input.length);
  new Uint8Array(e.memory.buffer).set(input, ptr);
  const packed: bigint = e[method](ptr, input.length);
  e.wasm_free(ptr);
  const out = Number(packed >> 32n),
    len = Number(packed & 0xffffffffn);
  if (len > 131072) throw new Error("Interpreter response limit exceeded");
  const result = decode(new Uint8Array(e.memory.buffer, out, len));
  e.wasm_free(out);
  return result;
}
