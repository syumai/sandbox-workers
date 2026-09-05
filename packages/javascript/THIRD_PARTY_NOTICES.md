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
