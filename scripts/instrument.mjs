import { dirname } from "node:path";
import binaryen from "binaryen";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
export async function instrument(input, output, maxPages = 1024) {
  await mkdir(dirname(output), { recursive: true });
  const m = binaryen.readBinary(await readFile(input));
  if (m.getFunction("__sandbox_tick"))
    throw new Error("Engine already metered; rebuild the snapshot first");
  m.addFunctionImport(
    "__sandbox_tick",
    "sandbox",
    "tick",
    binaryen.none,
    binaryen.none,
  );
  for (let i = 0; i < m.getNumFunctions(); i++) {
    const fn = m.getFunctionByIndex(i);
    const info = binaryen.getFunctionInfo(fn);
    if (info.body)
      binaryen.Function.setBody(
        fn,
        m.block(
          null,
          [m.call("__sandbox_tick", [], binaryen.none), info.body],
          info.results,
        ),
      );
  }
  let wat = m.emitText();
  let loops = 0;
  let memories = 0;
  wat = wat.replace(
    /\(loop (\$[^\s()]+)(\s*\(result [^)]*\))?/g,
    (_, label, result = "") => {
      loops++;
      return `(loop ${label}${result} (call $__sandbox_tick)`;
    },
  );
  // Limit linear memory to 64 MiB, leaving headroom within Workers' 128 MiB isolate.
  // A `shared` memory (the JavaScript engine, for its never-enabled thread-spawn
  // path) declares an explicit max already and must keep the `shared` keyword on
  // the way back out, or the module reverts to unshared and its thread-spawn /
  // Atomics imports no longer validate.
  wat = wat.replace(
    /\(memory (\$[^\s()]+) (\d+)(?: \d+)?( shared)?\)/,
    (_, name, initial, shared = "") => {
      memories++;
      if (+initial > maxPages) throw new Error("Initial memory exceeds budget");
      return `(memory ${name} ${initial} ${maxPages}${shared})`;
    },
  );
  if (!loops || memories !== 1)
    throw new Error(
      "Unexpected engine structure: metering or memory cap missing",
    );
  const out = binaryen.parseText(wat);
  out.setFeatures(
    m.getFeatures() |
      binaryen.Features.BulkMemory |
      binaryen.Features.BulkMemoryOpt |
      binaryen.Features.SignExt |
      binaryen.Features.MutableGlobals |
      binaryen.Features.NontrappingFPToInt |
      binaryen.Features.ReferenceTypes |
      binaryen.Features.ExceptionHandling |
      // Required to validate the JavaScript engine's shared memory and any
      // atomic instructions it contains (Atomics is deleted from the guest's
      // globalThis, but the compiled Wasm module can still use these ops).
      binaryen.Features.Atomics,
  );
  if (!out.validate()) throw new Error("Invalid metered engine");
  await writeFile(output + ".tmp", out.emitBinary());
  await rename(output + ".tmp", output);
  console.log(
    `Metered ${loops} loops and all function entries; ${out.emitBinary().length} bytes`,
  );
  m.dispose();
  out.dispose();
}
