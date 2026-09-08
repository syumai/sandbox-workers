# @sandbox-workers/cli

One initializer for JavaScript, Python, Perl, and Ruby sandbox Workers.

```sh
pnpm dlx @sandbox-workers/cli init python,javascript my-runtimes
cd my-runtimes
pnpm install
pnpm dry-run
pnpm run deploy
```

Usage: `sandbox-workers init <runtime>[,<runtime>...] [directory] [--stateless]`. `<runtime>` is a comma-separated list drawn from `javascript`, `python`, `perl`, `ruby` (order preserved, no duplicates, at least one required). Omit the directory to use `sandbox-runtimes`. `--stateless` applies to every runtime in the list, and may appear before or after the directory. `--help` lists supported runtimes.

The CLI creates one Worker entrypoint (`<runtime>.js`) and one Wrangler configuration (`wrangler.<runtime>.jsonc`) per selected runtime, plus a single package manifest whose `dev`/`deploy`/`dry-run` scripts cover every runtime, a README, and an ignore file — the same shape whether one or several runtimes were requested. It refuses to overwrite existing files, including symlinks. It never installs dependencies or deploys automatically. Public and preview URLs are disabled. Choose unique Worker names and bind your application to each of them after deployment.

Review each selected runtime's `LICENSE`, `THIRD_PARTY_NOTICES.md`, and bundled licenses before use or redistribution. The MIT license for sandbox-workers code does not replace the upstream interpreter licenses. The generated README links to those documents; installed copies live in `node_modules/@sandbox-workers/<runtime>/`.

To use a local build instead, run `node packages/cli/bin/cli.mjs init python,javascript /tmp/my-runtimes`, then install the runtime tarballs in that directory.
