---
title: Playground
description: Try each engine using the same packages you can deploy.
---

The Playground is at the [site root](/docs/../). Choose a runtime from the selector, load an example, edit its function body, and provide JSON input. Click **Run code** or press Cmd/Ctrl+Enter.

- **Result** shows the returned JSON value or execution error.
- **Console** shows captured output.
- **JSON** shows the complete response, including duration and fuel usage.

JavaScript supports `await`; Python, Perl, and Ruby use synchronous function bodies. Use `$input` for Perl and `input` for the other languages. Return values must be JSON-compatible.

Code and input drafts are saved in this browser's local storage. Running code sends it to the Playground's engines; self-hosted clients use your own Service Bindings instead. Do not put production credentials in a public demo.

The deployment section updates its CLI and binding examples for the selected language. See [language pages](/runtimes/javascript) for examples and compatibility details.
