---
title: Troubleshooting
description: Diagnose deployment, binding, and execution failures.
---

## Deploy button shows a missing repository

Cloudflare's button requires a public repository. Confirm that the template exists on the referenced branch and the source repository is public. Private GitHub access in your browser does not give anonymous Workers Builds downloads access.

## Source checksum mismatch

Do not bypass verification. Confirm that `runtime-source.json` points to the intended immutable commit and that its digest was calculated from that exact archive. Update the pin and digest together only after reviewing the new source.

## Build cannot find a workspace package

Deploy the complete isolated `templates/<language>` directory. Do not point a button directly at `packages/<language>`: it depends on build-time workspace source. For npm-based deployment, wait for publication or install a locally packed runtime.

## The runtime has no public URL

This is expected. Public and preview URLs are disabled. Call it through a Service Binding in another Worker.

## Binding unavailable or wrong language

Check the deployed Worker name and account. In local development, ensure the engine's Wrangler process is running. Select the language that matches that binding; the language field does not route to another Worker automatically.

## Execution fuel exhausted

Reduce computation or imported libraries. Fuel includes interpreter initialization. Loops, recursion, and expensive engine operations consume the budget. Retrying unchanged code does not increase it.

## Unsupported Python module

This build cannot initialize `_decimal` because mpdecimal host imports are unresolved. `decimal`, `fractions`, and `statistics` are consequently unsupported. Installing pip packages or arbitrary native extensions is not supported.

## Ruby JavaScript bridge is disabled

`JS.global` and related bridge functions are intentionally blocked to keep guest code from accessing the Worker host. Pass the data you need as JSON input.

## Production CPU limit exceeded

Use a Paid plan and inspect its CPU configuration. Local wall-clock timings do not predict production CPU billing. The 64 MiB bundle size limit is separate from CPU and total isolate memory.
