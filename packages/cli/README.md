# @sandbox-workers/cli

One initializer for JavaScript, Python, Perl, and Ruby sandbox Workers. Version 0.1.0 preview; npm publication is pending.

```sh
pnpm dlx @sandbox-workers/cli init python my-sandbox
cd my-sandbox
ppnpm install
pnpm dry-run
pnpm run deploy
```

Usage: `sandbox-workers init <javascript|python|perl|ruby> [directory]`. Omit the directory to use `sandbox-<runtime>`. `--help` lists supported runtimes.

The CLI creates the Worker entrypoint, package manifest, Wrangler configuration, README, and ignore file. It refuses to overwrite existing files, including symlinks. It never installs dependencies or deploys automatically. Public and preview URLs are disabled. Choose a unique Worker name and bind your application to it after deployment.

Review the selected runtime's `LICENSE`, `THIRD_PARTY_NOTICES.md`, and bundled licenses before use or redistribution. The MIT license for sandbox-workers code does not replace the upstream interpreter licenses. The generated README links to those documents; installed copies live in `node_modules/@sandbox-workers/<runtime>/`.

For a local unreleased build, run `node packages/cli/bin/cli.mjs init python /tmp/my-sandbox`, then install the runtime tarball in that directory.
