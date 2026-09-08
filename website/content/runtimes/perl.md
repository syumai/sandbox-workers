---
title: Perl
description: Execute code with Perl 5.42.2 (goccy/perl-wasm v0.2.1) inside a dedicated Wasm Worker.
---

Package: `@sandbox-workers/perl`. Code is a script: the value of the last expression is the result. Env vars are available as `%ENV`, e.g. `$ENV{NAME}`. The wrapper uses JSON::PP for values and captures stdout. Includes a read-only standard library; CPAN installations and arbitrary native extensions are unavailable.

Engine: Perl 5.42.2 compiled to Wasm by [goccy/perl-wasm](https://github.com/goccy/perl-wasm) v0.2.1.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fperl)

Or, with the CLI:

```sh
pnpm dlx @sandbox-workers/cli init perl my-sandbox
```

See [deployment setup](/deploy) and [Service Bindings](/configuration/wrangler). The template requires a Paid plan and creates no public URL.

## Example

Env vars:

```json
{ "NAME": "world" }
```

Code:

```perl
my $name = $ENV{NAME} // "world";
print "Hello from Perl!\n";
+{message => "Hello, $name!", squares => [map { $_ * $_ } 0..5]};
```

Every request gets a fresh engine instance. State does not persist between executions. Consult [limits](/platform/limits) for fuel, memory, and output budgets.

## License notice

Before use or redistribution, review this runtime's [LICENSE](https://github.com/syumai/sandbox-workers/blob/main/packages/perl/LICENSE) and [THIRD_PARTY_NOTICES.md](https://github.com/syumai/sandbox-workers/blob/main/packages/perl/THIRD_PARTY_NOTICES.md). Bundled interpreters retain their upstream licenses. The package includes the applicable notices in its `licenses/` directory.
