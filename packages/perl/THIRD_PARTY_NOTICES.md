# Third-party notices

This package includes Perl 5.42.2, a WebAssembly bridge, browser_wasi_shim (MIT OR Apache-2.0), and fflate (MIT). See `licenses/` for their license texts. The adapter code is MIT (`LICENSE`).

Upstream Wasm source and build instructions: https://github.com/goccy/perl-wasm/tree/v0.2.1

Perl source: https://github.com/Perl/perl5/tree/v5.42.2
Perl is available under the Artistic License or GPL. The bridge is MIT.

The original Wasm is modified by `scripts/instrument.mjs` in the sandbox-workers repository: it inserts a fuel callback at function entries and loops and caps linear memory. The original interpreter source is unchanged. Python/Perl download URLs and SHA-256 digests are recorded in `scripts/runtime-sources.json`; Ruby's npm archive integrity is pinned in pnpm-lock.yaml.
