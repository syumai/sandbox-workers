# Third-party runtime notices

The host adapter, initializer, and guest wrapper are MIT licensed (LICENSE).
The distributed `dist/engine.wasm` embeds third-party software; the MIT license
alone does not cover that software.

- Fastly JavaScript Compute runtime 3.45.0: Apache-2.0 with LLVM exception.
  Full license: licenses/FASTLY.txt.
  Source: https://github.com/fastly/js-compute-runtime (release v3.45.0).
  Binary input: npm package @fastly/js-compute@3.45.0, fastly.wasm.
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
the sandbox-workers repository (scripts/meter.mjs and package-lock.json).
Preserve these notices when redistributing the runtime. Before publishing a
release, verify the complete upstream notices and matching source references
for the selected engine release (see the repository release checklist).
