---
title: Deploy to Cloudflare
description: Create a runtime Worker in your account from an isolated source template.
---

## Choose a runtime

Each button deploys one private engine Worker. Repeat for each language you need; the buttons do not deploy the Playground or your calling application.

### JavaScript

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fjavascript)

### Python

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fpython)

### Perl

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fperl)

### Ruby

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fsyumai%2Fsandbox-workers%2Ftree%2Fmain%2Ftemplates%2Fruby)

## Complete the setup

1. Connect your GitHub account in the Cloudflare setup flow.
2. Choose your Cloudflare account, repository name, and Worker name.
3. Keep the detected build command and deploy command from the template.
4. Wait for the pinned engine source to download, pass its checksum check, and build.
5. Add a [Service Binding](/guides/service-bindings) in your caller using the selected Worker name.

Initial builds take several minutes. The generated runtime retains upstream license notices. Review [runtime licenses](/reference/licenses) before use or redistribution. A Paid plan is required by the configured CPU limits.

## How the templates work

Cloudflare treats the selected `templates/<language>` directory as a new repository root. Each template is independent: its build script downloads an immutable source archive, verifies the SHA-256 digest in `runtime-source.json`, and builds only the chosen Wasm engine. It does not depend on sibling workspace packages or unpublished npm packages. The pinned historical snapshot builds internally with its own npm lockfile; current project development uses pnpm.

Wrangler invokes the build before deployment. A manifest verifies existing output and skips a rebuild only when its hashes and source pin match. Source verification also applies to offline test archives.

Public and preview URLs remain disabled. There are no required secrets, databases, or network bindings. The caller's Service Binding is configured separately.

## Availability

Deploy buttons require a public GitHub or GitLab source repository. While this repository is private, the buttons and anonymous source downloads are unavailable. The templates must also be pushed to the referenced `main` branch before others can use them. The Cloudflare account creation and final deployment are completed by the person clicking the button.

See Cloudflare's [Deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) for the hosting flow and repository requirements.
