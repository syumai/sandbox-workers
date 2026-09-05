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

## Session mode

A **Script**/**Session** toggle sits next to the runtime selector. **Script** is the behavior above: every run boots a fresh, stateless instance. **Session** switches `Run` to POST against a durable, per-browser [session](/guides/sessions) instead — `/languages/<language>/sessions/<id>/execute` — so top-level variables, functions, and a writable `/workspace` persist from one run to the next, exactly like a REPL. Ruby has no session mode (sessions aren't supported for Ruby — the toggle is disabled with a tooltip explaining why), and switching languages away from Ruby restores whichever mode you last used.

The Playground generates one session id per browser and language (`pg-<random>`, kept in local storage) the first time you switch to Session mode, and reuses it on later visits. In the result pane:

- A **session bar** shows the current session id with **New session** (deletes the current session and starts a fresh id) and **Reset** (drops the interpreter's state and memory snapshot, keeping `/workspace` and the id) buttons.
- A **session strip** shows the running execution count, `cwd`, the stored memory-snapshot page count, and a relative "expires in…" time, refreshed after every run — see [Idle expiry](/guides/sessions#idle-expiry) for what that countdown means and how to change it on a self-hosted runtime Worker.
- A **transcript** lists the session's recent runs (code and first result or error), collapsed above the current output, so the pane reads like a REPL history. **New session** and **Reset** clear it.
- A fourth **Workspace** tab browses the session's `/workspace` directory (via the files API): open a file to view it, create or overwrite one by name, or delete one. It refreshes after every run.

The example library includes one session-oriented example per supported language — it defines a small counter and a function, and says "Run again to see the counter increase" so the persistence is visible without switching examples.
