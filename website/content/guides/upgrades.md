---
title: Upgrades and releases
description: Update engines deliberately and preserve their license notices.
---

## Package installations

Update the selected runtime dependency, inspect its release notes and licenses, run a dry-run, and redeploy that runtime Worker. Existing Service Bindings continue to target its Worker name. Updating a dependency without redeploying does not change a running Worker.

## Deploy-button installations

`runtime-source.json` pins an immutable source commit and archive digest. Update both together. The next build regenerates the runtime and its notices; output with mismatched hashes is never reused.

The source pin is independent of the template repository's branch. Pulling template changes alone does not silently select a new engine revision.

## Durable sandbox storage format

The `Sandbox` Durable Object's on-disk layout carries a `format` number in its stored metadata. When a deploy changes that layout, the Durable Object detects the mismatch on first access after the deploy and wipes that sandbox's storage — files, code contexts, and their snapshots — starting it fresh rather than attempting a migration; there is no way to recover a wiped sandbox's state. This has happened once before (format 1 → 2, when the single-REPL "session" model became multiple named code contexts) and again for format 3 (see [`docs/snapshot-cost-design.md`](https://github.com/syumai/sandbox-workers/blob/main/docs/snapshot-cost-design.md)), which replaced the per-page `pages` table with a chunked `chunks` table and folded each context's snapshot record into its own row. Any sandbox created before a format-3 deploy is discarded the next time it's touched. For the public Playground, whose idle TTL is an hour, this is a non-event in practice; a deployment with a long or disabled `SESSION_IDLE_TTL_MS` should expect long-lived sandboxes to be reset by a format-changing upgrade.

## Maintainer releases

Keep package versions, CLI version, and runtime metadata aligned. Build and pack all libraries and the CLI, run type checks and tests, then validate the tarballs outside the workspace. Publish the exact tested tarballs. Preserve each runtime's LICENSE, THIRD_PARTY_NOTICES.md, and bundled license files.

```sh
pnpm run pack
pnpm check
pnpm test
pnpm test:package
```

Publishing npm packages, publishing this source repository, and deploying the Playground are separate operations. They are not performed by the initializer.
