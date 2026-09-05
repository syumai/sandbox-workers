# Third-party runtime notices

The host adapter, initializer, and guest wrapper are MIT licensed (LICENSE).
The distributed `dist/engine.wasm` embeds third-party software; the MIT license
alone does not cover that software.

- Fastly JavaScript Compute runtime 3.45.0: Apache-2.0 with LLVM exception.
  Full license: licenses/FASTLY.txt.
  Source: https://github.com/fastly/js-compute-runtime (release v3.45.0).
  Binary input: npm package @fastly/js-compute@3.45.0, fastly.wasm.
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
- SpiderMonkey / Mozilla code in the upstream runtime: MPL-2.0 and the
  applicable notices in the upstream source files.
  License: https://www.mozilla.org/MPL/2.0/
  Upstream build/dependency source references:
  https://github.com/fastly/js-compute-runtime/tree/v3.45.0
  https://github.com/bytecodealliance/StarlingMonkey
  https://firefox-source-docs.mozilla.org/js/

The upstream C++ sources are not edited by sandbox-workers. The binary is
snapshotted with the included src/guest.js and instrumented with fuel calls and
a linear-memory ceiling. Reproduction sources and pinned dependencies are in
the sandbox-workers repository (scripts/meter.mjs and pnpm-lock.yaml).
Preserve these notices when redistributing the runtime. Before publishing a
release, verify the complete upstream notices and matching source references
for the selected engine release (see the repository release checklist).
