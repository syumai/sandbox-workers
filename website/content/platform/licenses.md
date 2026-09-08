---
title: Runtime licenses
description: Review each runtime license before use or redistribution.
---

The original sandbox-workers code is MIT licensed, copyright (c) 2026 syumai. This applies to the adapters, shared client, CLI, and site. Bundled interpreters and other third-party software retain their own licenses.

## Upstream engines

These projects produce the Wasm binaries this project ships; each package's `THIRD_PARTY_NOTICES.md` lists their licenses.

| Runtime    | Interpreter    | Wasm build                                                             | Version |
| ---------- | -------------- | ----------------------------------------------------------------------- | ------- |
| JavaScript | SpiderMonkey 147 | [goccy/spidermonkey-wasm](https://github.com/goccy/spidermonkey-wasm) | v0.2.6  |
| Python     | CPython 3.14.6 | [goccy/python-wasm](https://github.com/goccy/python-wasm)             | v0.2.0  |
| Perl       | Perl 5.42.2    | [goccy/perl-wasm](https://github.com/goccy/perl-wasm)                 | v0.2.1  |
| Ruby       | CRuby 4.0.0    | [ruby.wasm](https://github.com/ruby/ruby.wasm)                        | 2.10.1  |

| Runtime    | License and upstream notices                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript | [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/javascript/LICENSE) · [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/javascript/THIRD_PARTY_NOTICES.md) |
| Python     | [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/python/LICENSE) · [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/python/THIRD_PARTY_NOTICES.md)         |
| Perl       | [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/perl/LICENSE) · [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/perl/THIRD_PARTY_NOTICES.md)             |
| Ruby       | [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/ruby/LICENSE) · [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/ruby/THIRD_PARTY_NOTICES.md)             |

## Before using a runtime

Read the selected package's **LICENSE**, **THIRD_PARTY_NOTICES.md**, and **licenses/** directory. The adapter's MIT license does not replace the interpreter licenses. Preserve the applicable notices when redistributing the package or generated runtime.

The shared CLI prints this reminder and writes runtime-specific links into the generated README. Published packages include their notices; Deploy-button builds copy them into `runtime/LICENSE`, `runtime/THIRD_PARTY_NOTICES.md`, and `runtime/licenses/`.

Review the corresponding source references when distributing modified Wasm. Fuel instrumentation and memory caps modify the binary even though the upstream interpreter source is unchanged. The source revision and checksums record which build you are using.
