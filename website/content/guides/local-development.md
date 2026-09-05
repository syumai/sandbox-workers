---
title: Local development
description: Build the pnpm workspace and preview the complete site.
---

Requires Node.js 22.12 or newer and pnpm 10.7.1. The workspace contains runtime libraries, core, the shared CLI, and the Blume site.

```sh
pnpm install --frozen-lockfile
pnpm dev
# http://localhost:8787/
# http://localhost:8787/docs/
```

The first build downloads pinned engine artifacts and instruments Wasm; allow several minutes.

```sh
pnpm build:packages  # Host, core, and metadata
pnpm build:ui        # Playground plus Blume docs
pnpm build:docs      # Only Blume and its copied assets
pnpm docs:dev        # Blume hot reload
pnpm docs:check      # Documentation link validation
pnpm check
pnpm test
pnpm test:http      # Running Playground required
pnpm dry-run        # No production deployment
```

Documentation source lives in `website/content/`. Blume builds static HTML, local search, Markdown mirrors, and llms.txt. The docs mount at `/docs/`; the Playground retains `/`. Set `DOCS_SITE_URL` to your production origin when building if you want canonical URLs and sitemap metadata.

## Deployment template maintenance

```sh
pnpm templates:generate
pnpm test:templates
```

The generator copies the shared build script into four isolated directories. Template tests copy each directory outside the repository before installing and building. While the source repository is private, provide an authenticated, previously downloaded archive through `SANDBOX_SOURCE_ARCHIVE`; its checksum is still enforced.
