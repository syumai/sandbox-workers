# Third-party notices

This package includes CRuby 4.0.0, a WebAssembly bridge, browser_wasi_shim (MIT OR Apache-2.0), and fflate (MIT). See `licenses/` for their license texts. The adapter code is MIT (`LICENSE`).

Upstream Wasm source and build instructions: https://github.com/ruby/ruby.wasm/tree/2.10.1

CRuby source: https://github.com/ruby/ruby/tree/v4.0.0
CRuby is available under Ruby or BSD-2-Clause licensing. `licenses/LEGAL.txt` records component-specific notices. The Wasm bridge is MIT.

The original Wasm is modified by `scripts/instrument.mjs` in the sandbox-workers repository: it inserts a fuel callback at function entries and loops and caps linear memory. The original interpreter source is unchanged. Python/Perl download URLs and SHA-256 digests are recorded in `scripts/runtime-sources.json`; Ruby's npm archive integrity is pinned in pnpm-lock.yaml.
