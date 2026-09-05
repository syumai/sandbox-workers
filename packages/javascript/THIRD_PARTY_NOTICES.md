# Third-party notices

This package includes SpiderMonkey (Firefox 147), a WebAssembly embedding bridge, ICU
Unicode data, browser_wasi_shim (MIT OR Apache-2.0), and fflate (MIT). See `licenses/`
for their license texts. The adapter code is MIT (`LICENSE`).

- Acorn 8.18.0: MIT. Used by the host-side `transformForAsyncExecution` helper
  (src/transform.mjs) to rewrite a script's last expression into a `return`;
  esbuild bundles it into dist/worker.js, so it ships in this package's code,
  not as a separate npm dependency.
  Full license: licenses/ACORN.txt.
  Source: https://github.com/acornjs/acorn (npm package acorn@8.18.0).
- Sucrase 3.35.1: MIT. Used by the same host-side `transformForAsyncExecution`
  helper (src/transform.mjs) to strip TypeScript-only syntax (types, `enum`,
  `namespace`, parameter properties, `as`/`satisfies`) before handing the
  result to acorn; no type checking is performed. esbuild bundles it (and the
  small dependency tree below, pulled in transitively by its transform entry
  point) into dist/worker.js, so it ships in this package's code, not as a
  separate npm dependency. Sucrase's CLI entry points (bin/sucrase,
  dist/cli.js) and their dependencies (commander, mz, pirates, tinyglobby)
  are not imported and are not bundled.
  Full license: licenses/SUCRASE.txt.
  Source: https://github.com/alangpierce/sucrase (npm package sucrase@3.35.1).
- ts-interface-checker 0.1.13: Apache-2.0. A Sucrase runtime dependency
  (options validation); bundled transitively into dist/worker.js as above.
  Full license: licenses/TS-INTERFACE-CHECKER.txt.
  Source: https://github.com/gristlabs/ts-interface-checker
  (npm package ts-interface-checker@0.1.13).
- lines-and-columns 1.2.4: MIT. A Sucrase runtime dependency; bundled
  transitively into dist/worker.js as above.
  Full license: licenses/LINES-AND-COLUMNS.txt.
  Source: https://github.com/eventualbuddha/lines-and-columns
  (npm package lines-and-columns@1.2.4).
- @jridgewell/gen-mapping 0.3.13 and @jridgewell/sourcemap-codec 1.6.0: MIT.
  Sucrase runtime dependencies (source map generation, unused by this
  package's TypeScript-stripping call, which passes no `sourceMapOptions`);
  bundled transitively into dist/worker.js as above.
  Full licenses: licenses/JRIDGEWELL-GEN-MAPPING.txt and
  licenses/JRIDGEWELL-SOURCEMAP-CODEC.txt.
  Source: https://github.com/jridgewell/sourcemaps (npm packages
  @jridgewell/gen-mapping@0.3.13 and @jridgewell/sourcemap-codec@1.6.0).

Upstream Wasm source and build instructions: https://github.com/goccy/spidermonkey-wasm/tree/v0.2.6

The embedding bridge (`js.h` and the generated glue) is MIT licensed: `licenses/BRIDGE.txt`.
SpiderMonkey itself is built from a prebuilt distribution provided by
https://github.com/bytecodealliance/StarlingMonkey (wasm32-wasi, Intl/ICU enabled) and is
MPL-2.0 licensed: `licenses/MPL-2.0.txt`. The ICU data compiled into the engine for `Intl`
support is licensed under the Unicode License v3: `licenses/UNICODE.txt`.

The original Wasm is modified by `scripts/instrument.mjs` in the sandbox-workers repository:
it inserts a fuel callback at function entries and loops and caps linear memory. The
original interpreter source is unchanged. The download URL and SHA-256 digest are recorded
in `scripts/runtime-sources.json`.
