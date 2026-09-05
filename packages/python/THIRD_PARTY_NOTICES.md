# Third-party notices

This package includes CPython 3.14.6, a WebAssembly bridge, browser_wasi_shim (MIT OR Apache-2.0), and fflate (MIT). See `licenses/` for their license texts. The adapter code is MIT (`LICENSE`).

Upstream Wasm source and build instructions: https://github.com/goccy/python-wasm/tree/v0.2.0

CPython source: https://github.com/python/cpython/tree/v3.14.6
The Python license includes notices for bundled components.

The original Wasm is modified by `scripts/instrument.mjs` in the sandbox-workers repository: it inserts a fuel callback at function entries and loops and caps linear memory. The original interpreter source is unchanged. Python/Perl download URLs and SHA-256 digests are recorded in `scripts/runtime-sources.json`; Ruby's npm archive integrity is pinned in package-lock.json.
