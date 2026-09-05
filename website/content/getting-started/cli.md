---
title: CLI
description: Initialize any supported runtime with one command.
---

After npm publication, use the shared CLI:

```sh
pnpm dlx @sandbox-workers/cli init python my-sandbox
cd my-sandbox
pnpm install
pnpm dry-run
pnpm run deploy
```

```text
sandbox-workers init <javascript|python|perl|ruby> [directory]
sandbox-workers --help
```

The default directory is `sandbox-<runtime>`. The CLI creates an entrypoint, manifest, Wrangler configuration, README, and ignore file. Existing files and symlinks are never overwritten. It does not install packages or deploy automatically.

Each generated entrypoint imports the selected package:

```js
export { default } from "@sandbox-workers/python";
```

The generated README links to that runtime's `LICENSE` and `THIRD_PARTY_NOTICES.md`. Read them before use or redistribution. The installed engine has its own upstream licenses in addition to the MIT-licensed adapter.

## Before npm publication

Use a [source deployment template](/getting-started/deploy), or build local packages:

```sh
pnpm install --frozen-lockfile
pnpm run pack
node packages/cli/bin/cli.mjs init python /tmp/my-sandbox
cd /tmp/my-sandbox
pnpm add /absolute/path/to/dist/sandbox-workers-python-0.1.0.tgz
pnpm dry-run
```

To use npm instead of pnpm in a generated project, the equivalent `npm install` and `npm run` commands work. The repository itself is managed with pnpm workspace.
