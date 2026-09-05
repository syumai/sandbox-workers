---
title: Playground
description: Try each engine using the same packages you can deploy.
---

The Playground is at the [site root](/docs/../). Choose a runtime from the selector, load an example, edit the script, and provide env vars as JSON. Click **Run code** or press Cmd/Ctrl+Enter.

- **Result** shows the value of the last expression or the execution error.
- **Console** shows captured `stdout`/`stderr` output.
- **JSON** shows the complete response, including duration and fuel usage.

JavaScript supports `await`; all four languages evaluate code as a script whose last expression is the result. Env vars are read as `process.env` (JavaScript), `os.environ` (Python), `$ENV` (Perl), or `ENV` (Ruby) — the pane's label switches to match the selected language.

Code and env var drafts are saved in this browser's local storage. Running code sends it to the Playground's engines; self-hosted clients use your own Service Bindings instead. Do not put production credentials in a public demo.

The deployment section updates its CLI and binding examples for the selected language. See [language pages](/runtimes/javascript) for examples and compatibility details.
