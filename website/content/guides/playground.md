---
title: Playground
description: Try each engine using the same packages you can deploy.
---

The Playground is at the [site root](/). Choose a runtime from the selector, load an example, edit the script, and provide env vars as JSON. Click **Run code** or press Cmd/Ctrl+Enter.

- **Result** shows the value of the last expression or the execution error.
- **Console** shows captured `stdout`/`stderr` output.
- **JSON** shows the complete response, including duration and fuel usage.

JavaScript supports `await`; all four languages evaluate code as a script whose last expression is the result. Env vars are read as `process.env` (JavaScript), `os.environ` (Python), `$ENV` (Perl), or `ENV` (Ruby) — the pane's label switches to match the selected language.

Code and env var drafts are saved in this browser's local storage. Running code sends it to the Playground's engines; self-hosted clients use your own Service Bindings instead. Do not put production credentials in a public demo.

The deployment section updates its CLI and binding examples for the selected language. See [language pages](/runtimes/javascript) for examples and compatibility details.

## REPL mode

A **Script**/**REPL** toggle sits next to the runtime selector. **Script** is the behavior above: every run boots a fresh, stateless instance. **REPL** turns the editor pane into an actual line-at-a-time REPL: the prompt is a single fixed-height line — it never grows — and above it a **log** with its own fixed height shows every line you've submitted together with its result, scrolling internally as it fills up. Submitting a line POSTs it against the default code context of a durable, per-browser [sandbox](/guides/sessions) — `/languages/<language>/sandboxes/<id>/execute` — so top-level variables, functions, and a writable `/workspace` persist from one line to the next. Ruby has no REPL mode (code contexts aren't supported for Ruby — the toggle is disabled with a tooltip explaining why), and switching languages away from Ruby restores whichever mode you last used.

Entering REPL mode fills the prompt with a one-line declaration template (`let count = 1` in JavaScript, `count = 1` in Python, `our $count = 1;` in Perl) — a natural starting point, since the next lines to try are things like `count += 1` and `count`, which is exactly what makes state persistence visible. The aside's EXAMPLES list becomes **SNIPPETS**: a per-language list of one-liners (the declaration template first, then a couple more expressions and a small function) that insert into the prompt on click without evaluating it, so you can review or edit before submitting. Switching the editor's content — entering REPL, leaving it, or switching languages while in REPL — never touches your Script-mode draft: it's saved when you enter REPL and restored exactly when you leave, and the code saved to local storage is always the Script draft, never the REPL prompt.

In the prompt, **Enter** evaluates the line immediately — unless the code obviously isn't finished yet (an unbalanced bracket, or a line ending in `:`, `\`, or `,`), in which case it inserts a newline instead so multi-line definitions are easy to type; a multi-line prompt scrolls inside the prompt box rather than growing it. **Shift+Enter** always inserts a newline, and **Mod+Enter** always evaluates. **↑/↓** cycle through this session's previously submitted lines when the cursor is on the prompt's first or last line; editing a recalled line resets history navigation. The log fills in a cell as soon as it's submitted — code and a pending indicator right away, then the result (or error) in place once the response arrives — and clicking any past cell selects it and shows its full response (Result/Console/JSON) in the pane on the right.

The Playground generates one sandbox id per browser and language (`pg-<random>`, kept in local storage) the first time you switch to REPL mode, and reuses it on later visits. In the result pane:

- A **session bar** shows the current sandbox id with **New session** (deletes the sandbox, starts a fresh id, and clears the log) and **Reset** (deletes every code context listed by `GET /languages/<language>/sandboxes/<id>/contexts`, keeping `/workspace` and the id, and clears the log) buttons.
- A **session strip** shows the default context's running execution count, `cwd`, the stored memory-snapshot page count, and a relative "expires in…" time, refreshed after every evaluation — see [Idle expiry](/guides/sessions#idle-expiry) for what that countdown means and how to change it on a self-hosted runtime Worker.
- **Clear log** empties the visible REPL log for the current sandbox without touching the sandbox itself (no server call).
- A fourth **Workspace** tab browses the sandbox's `/workspace` directory (via the files API): open a file to view it, create or overwrite one by name, or delete one. It refreshes after every evaluation.

The REPL log is kept per session id and browser (reloading the page keeps it, minus the raw JSON payload for entries from before the reload), and the log's own scrollbar takes over once its fixed height fills up — the editor pane's overall height never changes, whether the log holds one line or fifty.
