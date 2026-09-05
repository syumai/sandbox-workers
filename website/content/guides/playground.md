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

## REPL mode

A **Script**/**REPL** toggle sits next to the runtime selector. **Script** is the behavior above: every run boots a fresh, stateless instance. **REPL** turns the editor pane into an actual REPL: the code editor shrinks to a one-line-and-growing prompt, and above it a scrolling **log** shows every line you've submitted together with its result, appended live as you go. Submitting a line POSTs it against a durable, per-browser [session](/guides/sessions) — `/languages/<language>/sessions/<id>/execute` — so top-level variables, functions, and a writable `/workspace` persist from one line to the next. Ruby has no REPL mode (sessions aren't supported for Ruby — the toggle is disabled with a tooltip explaining why), and switching languages away from Ruby restores whichever mode you last used.

In the prompt, **Enter** evaluates the line immediately — unless the code obviously isn't finished yet (an unbalanced bracket, or a line ending in `:`, `\`, or `,`), in which case it inserts a newline instead so multi-line definitions are easy to type. **Shift+Enter** always inserts a newline, and **Mod+Enter** always evaluates. **↑/↓** cycle through this session's previously submitted lines when the cursor is on the prompt's first or last line; editing a recalled line resets history navigation. The log fills in a cell as soon as it's submitted — code and a pending indicator right away, then the result (or error) in place once the response arrives — and clicking any past cell selects it and shows its full response (Result/Console/JSON) in the pane on the right.

The Playground generates one session id per browser and language (`pg-<random>`, kept in local storage) the first time you switch to REPL mode, and reuses it on later visits. In the result pane:

- A **session bar** shows the current session id with **New session** (deletes the current session, starts a fresh id, and clears the log) and **Reset** (drops the interpreter's state and memory snapshot, keeping `/workspace` and the id, and clears the log) buttons.
- A **session strip** shows the running execution count, `cwd`, the stored memory-snapshot page count, and a relative "expires in…" time, refreshed after every evaluation — see [Idle expiry](/guides/sessions#idle-expiry) for what that countdown means and how to change it on a self-hosted runtime Worker.
- **Clear log** empties the visible REPL log for the current session without touching the session itself (no server call).
- A fourth **Workspace** tab browses the session's `/workspace` directory (via the files API): open a file to view it, create or overwrite one by name, or delete one. It refreshes after every evaluation.

The REPL log is kept per session id and browser (reloading the page keeps it, minus the raw JSON payload for entries from before the reload). The example library includes one REPL-oriented example per supported language — it defines a small counter and a function, and says "Run again to see the counter increase" so the persistence is visible after you submit it a couple of times.
