---
title: Upgrades and releases
description: Update engines deliberately and preserve their license notices.
---

## Package installations

Update the selected runtime dependency, inspect its release notes and licenses, run a dry-run, and redeploy that runtime Worker. Existing Service Bindings continue to target its Worker name. Updating a dependency without redeploying does not change a running Worker.

## Deploy-button installations

`runtime-source.json` pins an immutable source commit and archive digest. Update both together. The next build regenerates the runtime and its notices; output with mismatched hashes is never reused.

The source pin is independent of the template repository's branch. Pulling template changes alone does not silently select a new engine revision.

## Maintainer releases

Keep package versions, CLI version, and runtime metadata aligned. Build and pack all libraries and the CLI, run type checks and tests, then validate the tarballs outside the workspace. Publish the exact tested tarballs. Preserve each runtime's LICENSE, THIRD_PARTY_NOTICES.md, and bundled license files.

```sh
pnpm run pack
pnpm check
pnpm test
pnpm test:package
```

Publishing npm packages, publishing this source repository, and deploying the Playground are separate operations. They are not performed by the initializer.
