import { Compartment, Prec } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import pyHello from "../examples/python/hello.py?raw";
import pyStdlib from "../examples/python/stdlib.py?raw";
import plHello from "../examples/perl/hello.pl?raw";
import plRegex from "../examples/perl/regex.pl?raw";
import rbHello from "../examples/ruby/hello.rb?raw";
import rbEnumerable from "../examples/ruby/enumerable.rb?raw";
import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";
import hello from "../examples/hello.js?raw";
import modern from "../examples/modern-javascript.js?raw";
import transform from "../examples/data-transform.js?raw";
import intl from "../examples/intl.js?raw";
import typescript from "../examples/typescript.ts?raw";
import "./style.css";
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "sandbox-workers-playground-v2";
const MAX_CELLS = 50;
const TABS = ["result", "console", "raw", "workspace"];
const javascriptExamples = [
  { name: "Hello, sandbox", code: hello, envVars: { NAME: "world" } },
  { name: "Modern JavaScript", code: modern, envVars: {} },
  {
    name: "Transform data",
    code: transform,
    envVars: { WORDS: "Books,Tools,Books,Books,Tools" },
  },
  { name: "Intl formatting", code: intl, envVars: {} },
  { name: "TypeScript", code: typescript, envVars: { NAME: "world" } },
];
const library = {
  javascript: javascriptExamples,
  python: [
    { name: "Hello, Python", code: pyHello, envVars: { NAME: "world" } },
    {
      name: "Standard library",
      code: pyStdlib,
      envVars: { WORDS: "hello,world,hello" },
    },
  ],
  perl: [
    { name: "Hello, Perl", code: plHello, envVars: { NAME: "world" } },
    {
      name: "Regular expressions",
      code: plRegex,
      envVars: { WORDS: "hello,world,hello,perl" },
    },
  ],
  ruby: [
    { name: "Hello, Ruby", code: rbHello, envVars: { NAME: "world" } },
    {
      name: "Enumerable",
      code: rbEnumerable,
      envVars: { WORDS: "ruby,wasm,hi,workers" },
    },
  ],
};
const envNames = {
  javascript: "process.env",
  python: "os.environ",
  perl: "$ENV",
  ruby: "ENV",
};
const clientSnippets = {
  javascript: "const x = Number(process.env.X);\nx ** 2",
  python: 'import os\nx = int(os.environ["X"])\nx ** 2',
  perl: "my $x = $ENV{X};\n$x ** 2",
  ruby: 'x = ENV["X"].to_i\nx ** 2',
};
// REPL SNIPPETS: one-liners inserted into the prompt on click (never
// auto-evaluated). The first entry in each list is the declaration
// template that fills the prompt on REPL entry / runtime switch — see
// fillReplPrompt(). Ruby has no REPL mode, so it has no snippet list.
const snippetLibrary = {
  javascript: [
    "let count = 1",
    "count += 1",
    "count * 10",
    "const greet = (name) => `Hello, ${name}!`",
    'greet("REPL")',
  ],
  python: [
    "count = 1",
    "count += 1",
    "count * 10",
    'def greet(name): return "Hello, " + name + "!"',
    'greet("REPL")',
  ],
  perl: [
    "our $count = 1;",
    "$count += 1;",
    "$count * 10",
    'sub greet { "Hello, $_[0]!" }',
    'greet("REPL")',
  ],
};
// Nudge shown in the empty REPL log before the first line is evaluated.
const replEmptyHints = {
  javascript:
    "Press Enter to evaluate the line. Then try `count += 1` and `count`.",
  python:
    "Press Enter to evaluate the line. Then try `count += 1` and `count`.",
  perl: "Press Enter to evaluate the line. Then try `$count += 1;` and `$count`.",
};
const syntax = new Compartment();
// Mode-specific editor keymap (Enter / ArrowUp / ArrowDown), only active in
// REPL mode — see replKeymapExtension() below.
const replKeys = new Compartment();
const modes = {
  javascript: javascript({ typescript: true }),
  python: python(),
  perl: StreamLanguage.define(perl),
  ruby: StreamLanguage.define(ruby),
};
let language = "javascript",
  examples = library.javascript;
let selected = 0,
  tab = "result",
  response,
  busy = false;
let requestedLanguage = null;
const param = new URLSearchParams(location.search).get("language");
if (library[param]) requestedLanguage = param;
let saved;
try {
  saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
} catch {}
// The Script-mode draft, kept separately from whatever the editor currently
// displays. In REPL mode the editor shows the prompt (a snippet or the
// user's in-progress line), never this draft; entering REPL saves the
// editor's current content here, and leaving REPL restores it. The
// persisted `code` field in local storage is always this draft (see
// persist()), never the REPL prompt.
let scriptDraft = typeof saved?.code === "string" ? saved.code : hello;
// REPL mode (see website/content/guides/playground.md "REPL mode").
// `userMode` is the mode the user picked ("script" or "repl"); Ruby has no
// REPL mode, so the *effective* mode (effectiveMode()) forces "script" there
// without losing the user's preference for the other languages. `sessionIds`
// maps each language to one Playground-generated session id, persisted so
// the same browser reuses it across visits. `cells` maps a session id to its
// last MAX_CELLS REPL log entries: {id, code, status, response, resultText,
// stdout, stderr, isError, durationMs}. A compact form (without `response`
// and without any still-pending entry) is persisted per session id so a
// reload keeps the REPL history visible.
let userMode =
  saved?.mode === "session" || saved?.mode === "repl" ? "repl" : "script";
let sessionIds =
  saved?.sessionIds &&
  typeof saved.sessionIds === "object" &&
  !Array.isArray(saved.sessionIds)
    ? { ...saved.sessionIds }
    : {};
let cellSeq = 0;
let cells = {};
if (
  saved?.cells &&
  typeof saved.cells === "object" &&
  !Array.isArray(saved.cells)
) {
  for (const [sid, list] of Object.entries(saved.cells)) {
    if (!Array.isArray(list)) continue;
    cells[sid] = list
      .filter((c) => c && typeof c.code === "string")
      .slice(-MAX_CELLS)
      .map((c) => ({
        id: ++cellSeq,
        code: c.code,
        status: "done",
        response: undefined,
        resultText: typeof c.resultText === "string" ? c.resultText : "",
        stdout: Array.isArray(c.stdout) ? c.stdout : [],
        stderr: Array.isArray(c.stderr) ? c.stderr : [],
        isError: !!c.isError,
        durationMs: typeof c.durationMs === "number" ? c.durationMs : undefined,
      }));
  }
}
// Per-session-id UI state (not persisted): which cell is shown in the result
// pane, and whether the log should keep following the newest cell.
let selectedCellId = {};
let followLatest = {};
for (const [sid, list] of Object.entries(cells)) {
  followLatest[sid] = true;
  selectedCellId[sid] = list.length ? list[list.length - 1].id : undefined;
}
// REPL prompt history (ArrowUp/ArrowDown). historyCursor indexes into the
// current session's cell codes; historyDraft holds the in-progress text that
// was showing before history navigation started.
let historyCursor = null;
let historyDraft = "";
let historyRecalling = false;
let workspaceOpenPath = null;
// Bumped whenever the "current run" identity changes (language switch, New
// session, Reset). In-flight requests started before a bump must not touch
// shared UI (status/metrics/response/display) once it no longer matches —
// see run(), runScript() and runReplCell().
let generation = 0;
function effectiveMode() {
  return language === "ruby" ? "script" : userMode;
}
function newSessionId() {
  return `pg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function sessionIdFor(lang) {
  if (!sessionIds[lang]) {
    sessionIds[lang] = newSessionId();
    persist();
  }
  return sessionIds[lang];
}

// ---- REPL keymap ------------------------------------------------------
// Tiny "does this obviously continue?" heuristic: unbalanced brackets, or a
// trailing ':' (Python block header), '\' (line continuation) or ','
// (unfinished argument/tuple list). Anything else submits on Enter.
function needsContinuation(code) {
  let depth = 0;
  for (const ch of code) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  if (depth > 0) return true;
  const trimmed = code.trimEnd();
  return (
    trimmed.endsWith(":") || trimmed.endsWith("\\") || trimmed.endsWith(",")
  );
}
function replEnterHandler(view) {
  const code = view.state.doc.toString();
  if (!code.trim()) return false;
  if (needsContinuation(code)) return false;
  submitReplLine();
  return true;
}
function atFirstLine(view) {
  const sel = view.state.selection.main;
  return sel.empty && view.state.doc.lineAt(sel.head).number === 1;
}
function atLastLine(view) {
  const sel = view.state.selection.main;
  return (
    sel.empty && view.state.doc.lineAt(sel.head).number === view.state.doc.lines
  );
}
function recallHistory(view, code) {
  historyRecalling = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: code },
    selection: { anchor: code.length },
  });
  historyRecalling = false;
}
function historyUp(view) {
  if (!atFirstLine(view)) return false;
  const list = (cells[sessionIdFor(language)] ?? []).map((c) => c.code);
  if (!list.length) return false;
  if (historyCursor === null) {
    historyDraft = view.state.doc.toString();
    historyCursor = list.length - 1;
  } else if (historyCursor > 0) {
    historyCursor--;
  } else {
    return true;
  }
  recallHistory(view, list[historyCursor]);
  return true;
}
function historyDown(view) {
  if (!atLastLine(view)) return false;
  if (historyCursor === null) return false;
  const list = (cells[sessionIdFor(language)] ?? []).map((c) => c.code);
  historyCursor++;
  if (historyCursor >= list.length) {
    recallHistory(view, historyDraft);
    historyCursor = null;
    historyDraft = "";
  } else {
    recallHistory(view, list[historyCursor]);
  }
  return true;
}
function replKeymapExtension() {
  return Prec.highest(
    keymap.of([
      { key: "Enter", run: replEnterHandler },
      { key: "ArrowUp", run: historyUp },
      { key: "ArrowDown", run: historyDown },
    ]),
  );
}

const editor = new EditorView({
  doc: typeof saved?.code === "string" ? saved.code : hello,
  extensions: [
    basicSetup,
    syntax.of(modes.javascript),
    replKeys.of([]),
    oneDark,
    EditorView.lineWrapping,
    keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          if (effectiveMode() === "repl") submitReplLine();
          else run();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        $("dirty").textContent = "•";
        if (!historyRecalling) {
          historyCursor = null;
          historyDraft = "";
        }
        persist();
      }
    }),
  ],
  parent: $("editor"),
});
if (typeof saved?.envVars === "string") $("env-vars").value = saved.envVars;
function compactCells() {
  const out = {};
  for (const [sid, list] of Object.entries(cells)) {
    out[sid] = list
      .filter((c) => c.status !== "pending")
      .map(({ code, resultText, stdout, stderr, isError, durationMs }) => ({
        code,
        resultText,
        stdout,
        stderr,
        isError,
        durationMs,
      }));
  }
  return out;
}
function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        language,
        // Always the Script draft — never the REPL prompt, see scriptDraft.
        code:
          effectiveMode() === "repl"
            ? scriptDraft
            : editor.state.doc.toString(),
        envVars: $("env-vars").value,
        mode: userMode,
        sessionIds,
        cells: compactCells(),
      }),
    );
  } catch {}
}
function selectExample(index) {
  selected = index;
  const e = examples[index];
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: e.code },
  });
  $("env-vars").value = JSON.stringify(e.envVars, null, 2);
  $("dirty").textContent = "";
  persist();
  for (const [i, button] of [...$("examples").children].entries()) {
    button.classList.toggle("active", i === index);
    button.setAttribute("aria-current", String(i === index));
  }
}
// Fills the REPL prompt with `code` without evaluating it — used both for
// the declaration template (fillReplPrompt) and for SNIPPETS clicks
// (insertSnippet).
function setPromptCode(code) {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: code },
    selection: { anchor: code.length },
  });
}
function fillReplPrompt(lang) {
  setPromptCode(snippetLibrary[lang]?.[0] ?? "");
}
function insertSnippet(code) {
  if (effectiveMode() !== "repl") return;
  setPromptCode(code);
  editor.focus();
}
function enterScriptDraft() {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: scriptDraft },
  });
  $("dirty").textContent = "";
}
// Renders the aside's per-mode list: EXAMPLES (Script, click loads the full
// example) or SNIPPETS (REPL, click inserts the one-liner into the prompt
// without evaluating it).
function renderAsideList() {
  const isRepl = effectiveMode() === "repl";
  $("examples-label-text").textContent = isRepl ? "SNIPPETS" : "EXAMPLES";
  const list = isRepl ? (snippetLibrary[language] ?? []) : examples;
  $("examples").replaceChildren();
  list.forEach((item, i) => {
    const button = document.createElement("button");
    if (isRepl) {
      button.textContent = `${String(i + 1).padStart(2, "0")}  ${item}`;
      button.title = item;
      button.className = "snippet";
      button.onclick = () => insertSnippet(item);
    } else {
      button.textContent = `${String(i + 1).padStart(2, "0")}  ${item.name}`;
      button.className = i === 0 ? "active" : "";
      button.onclick = () => selectExample(i);
    }
    $("examples").append(button);
  });
  $("example-count").textContent = String(list.length).padStart(2, "0");
}
function switchLanguage(next, restore = false) {
  generation++;
  language = next;
  examples = library[next];
  editor.dispatch({ effects: syntax.reconfigure(modes[next]) });
  renderAsideList();
  if (effectiveMode() === "repl") {
    fillReplPrompt(next);
  } else {
    selectExample(0);
    if (restore && typeof saved?.code === "string") {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: saved.code },
      });
      if (typeof saved.envVars === "string")
        $("env-vars").value = saved.envVars;
    }
  }
  $("env-name").textContent = envNames[next];
  $("install-command").textContent =
    `pnpm dlx @sandbox-workers/cli init ${next} my-sandbox\ncd my-sandbox\npnpm install\npnpm dry-run\npnpm run deploy`;
  $("binding-command").textContent = JSON.stringify(
    { services: [{ binding: "SANDBOX", service: `sandbox-${next}` }] },
    null,
    2,
  );
  $("client-command").textContent =
    `import { createSandbox } from "@sandbox-workers/core";\n\nconst sandbox = createSandbox(env.SANDBOX);\nconst output = await sandbox.runCode(\n  ${JSON.stringify(clientSnippets[next])},\n  { envVars: { X: "12" } },\n);\n// { results: [{ text: "144" }], ... }`;
  response = undefined;
  historyCursor = null;
  historyDraft = "";
  $("output").textContent = "Run your code to see the result.";
  $("status").textContent = "Ready";
  $("log-count").textContent = "0";
  persist();
  syncModeUI();
}
renderAsideList();
$("language").onchange = () => switchLanguage($("language").value);
$("mode-script").onclick = () => setMode("script");
$("mode-session").onclick = () => setMode("repl");
for (const item of document.querySelectorAll(".runtime-item[data-language]")) {
  item.addEventListener("click", () => {
    const next = item.dataset.language;
    if (!library[next]) return;
    requestedLanguage = next;
    if ($("language").querySelector(`option[value="${next}"]`)) {
      $("language").value = next;
      switchLanguage(next);
    }
  });
}
$("env-vars").oninput = persist;
$("reset").onclick = () => selectExample(selected);
$("repl-clear").onclick = () => {
  const sid = sessionIdFor(language);
  cells[sid] = [];
  selectedCellId[sid] = undefined;
  followLatest[sid] = true;
  historyCursor = null;
  historyDraft = "";
  persist();
  renderReplLog(sid, true);
  display();
};
$("run").onclick = run;
function logRow(label, text, isError) {
  const row = document.createElement("div");
  row.className = `log ${isError ? "error" : ""}`;
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const textEl = document.createElement("pre");
  textEl.textContent = text;
  row.append(labelEl, textEl);
  return row;
}
function display() {
  if (tab === "workspace") {
    renderWorkspacePanel($("output"));
    return;
  }
  if (effectiveMode() === "repl") {
    displayReplSelection();
    return;
  }
  const out = $("output");
  if (!response) {
    out.textContent = "Run your code to see the result.";
    return;
  }
  out.replaceChildren();
  const pre = document.createElement("pre");
  if (tab === "console") {
    const stdout = response.logs?.stdout ?? [];
    const stderr = response.logs?.stderr ?? [];
    if (!stdout.length && !stderr.length) {
      pre.textContent = "No console output.";
      pre.className = "muted";
      out.append(pre);
    }
    for (const text of stdout) out.append(logRow("stdout", text, false));
    for (const text of stderr) out.append(logRow("stderr", text, true));
  } else if (tab === "raw") {
    pre.textContent = JSON.stringify(response, null, 2);
    out.append(pre);
  } else if (response.error) {
    const { name, message, traceback } = response.error;
    pre.textContent = [`${name}: ${message}`, ...(traceback ?? [])].join("\n");
    pre.className = "error";
    out.append(pre);
  } else {
    const result = response.results?.[0];
    if (!result) {
      pre.textContent = "No result (the last expression was undefined).";
      pre.className = "muted";
    } else if (result.json !== undefined) {
      pre.textContent = JSON.stringify(result.json, null, 2);
    } else {
      pre.textContent = result.text;
    }
    out.append(pre);
  }
}
for (const name of TABS)
  $(name + "-tab").onclick = () => {
    if ($(name + "-tab").hidden) return;
    tab = name;
    for (const t of TABS)
      $(t + "-tab").setAttribute("aria-selected", String(t === tab));
    display();
  };
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("output").innerText);
    $("copy").textContent = "✓";
    setTimeout(() => ($("copy").textContent = "⧉"), 1500);
  } catch {
    $("status").textContent = "Copy unavailable";
  }
};
function parseEnvVars(text) {
  const value = JSON.parse(text || "{}");
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("envVars must be an object");
  for (const v of Object.values(value))
    if (typeof v !== "string")
      throw new Error("envVars values must be strings");
  return value;
}

function run() {
  if (effectiveMode() === "repl") {
    submitReplLine();
    return;
  }
  runScript();
}

// Stateless "Script" mode: boots a fresh instance per run. `lang` is
// captured up front and used for both the URL and every staleness check, so
// a runtime switch while the request is in flight can never let an older
// response overwrite a newer language's UI.
async function runScript() {
  if (busy) return;
  let envVars;
  try {
    envVars = parseEnvVars($("env-vars").value);
  } catch {
    $("status").textContent = "Invalid env vars JSON";
    $("env-vars").focus();
    return;
  }
  busy = true;
  $("run").disabled = true;
  $("status").textContent = "Running…";
  const gen = generation;
  const lang = language;
  const code = editor.state.doc.toString();
  const url = `/execute/${lang}`;
  let result;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, envVars }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.headers.get("content-type")?.includes("application/json"))
      throw new Error(`Worker returned HTTP ${res.status}`);
    result = await res.json();
  } catch (error) {
    result = {
      error: { name: error.name, message: error.message, traceback: [] },
      logs: { stdout: [], stderr: [] },
      results: [],
    };
  } finally {
    busy = false;
    $("run").disabled = false;
  }
  if (generation !== gen || language !== lang) return; // a newer run is now current
  response = result;
  $("status").textContent = response.error ? "Execution failed" : "✓ Completed";
  $("log-count").textContent =
    (response.logs?.stdout?.length ?? 0) + (response.logs?.stderr?.length ?? 0);
  $("metrics").children[0].textContent =
    response.durationMs === undefined
      ? "— ms"
      : `${response.durationMs.toFixed(1)} ms`;
  $("metrics").children[1].textContent = response.usage
    ? `${response.usage.fuelConsumed.toLocaleString()} / ${response.usage.fuelLimit.toLocaleString()} fuel`
    : "— fuel";
  display();
}

// ---- REPL mode --------------------------------------------------------
// See website/content/guides/playground.md "REPL mode" and
// website/content/guides/sessions.md for the underlying HTTP contract.

function setMode(next) {
  if ($("mode-session").disabled) next = "script";
  const wasRepl = effectiveMode() === "repl";
  userMode = next;
  const isRepl = effectiveMode() === "repl";
  if (!wasRepl && isRepl) {
    scriptDraft = editor.state.doc.toString();
    fillReplPrompt(language);
  } else if (wasRepl && !isRepl) {
    enterScriptDraft();
  }
  renderAsideList();
  persist();
  syncModeUI();
}

// Reconciles every mode-dependent bit of the UI with the current language +
// userMode. Called after switchLanguage() and setMode().
function syncModeUI() {
  const isRuby = language === "ruby";
  const isRepl = effectiveMode() === "repl";
  $("mode-script").setAttribute("aria-pressed", String(!isRepl));
  $("mode-session").setAttribute("aria-pressed", String(isRepl));
  $("mode-session").disabled = isRuby;
  $("mode-session").title = isRuby
    ? "REPL mode is not available for Ruby (sessions aren't supported)"
    : "Evaluate code in a durable, per-browser REPL session";
  $("session-bar").hidden = !isRepl;
  $("session-strip").hidden = !isRepl;
  $("workspace-tab").hidden = !isRepl;
  $("editor-pane").classList.toggle("repl", isRepl);
  $("repl-log").hidden = !isRepl;
  $("reset").hidden = isRepl;
  $("repl-clear").hidden = !isRepl;
  $("filename").textContent = isRepl
    ? "repl"
    : `experiment.${{ javascript: "js", python: "py", perl: "pl", ruby: "rb" }[language]}`;
  $("run").innerHTML = isRepl
    ? `↵ Eval <kbd>↵</kbd>`
    : `▶ Run code <kbd>⌘ ↵</kbd>`;
  $("editor").setAttribute(
    "aria-label",
    isRepl ? `${language} REPL prompt` : `${language} code editor`,
  );
  $("editor-mode").textContent = `${language} · ${isRepl ? "repl" : "script"}`;
  $("editor-footer-hint").textContent = isRepl
    ? "Enter evaluates · Shift+Enter newline · ↑↓ history"
    : "The last expression is the result";
  editor.dispatch({
    effects: replKeys.reconfigure(isRepl ? replKeymapExtension() : []),
  });
  if (!isRepl && tab === "workspace") {
    tab = "result";
    for (const t of TABS)
      $(t + "-tab").setAttribute("aria-selected", String(t === tab));
  }
  if (isRepl) {
    const sid = sessionIdFor(language);
    $("session-id").textContent = sid;
    if (selectedCellId[sid] === undefined) {
      const list = cells[sid] ?? [];
      selectedCellId[sid] = list.length ? list[list.length - 1].id : undefined;
      followLatest[sid] = true;
    }
    renderReplLog(sid, true);
    renderSessionStrip(null);
    refreshSessionInfo();
  }
  display();
}

function sessionBaseUrl(lang, sid) {
  return `/languages/${lang}/sessions/${sid}`;
}

async function refreshSessionInfo() {
  if (effectiveMode() !== "repl") return;
  const lang = language;
  const sid = sessionIdFor(lang);
  let info = null;
  try {
    const res = await fetch(sessionBaseUrl(lang, sid));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
  } catch {
    info = null;
  }
  if (!(language === lang && sessionIds[lang] === sid)) return; // a newer run is now current
  renderSessionStrip(info);
  if (tab === "workspace") loadWorkspace();
}

function relativeTime(ts) {
  const diffMs = ts - Date.now();
  if (diffMs <= 0) return "momentarily";
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

function renderSessionStrip(info) {
  $("session-id").textContent = sessionIdFor(language);
  if (!info) {
    $("session-executions").textContent = "0";
    $("session-cwd").textContent = "/workspace";
    $("session-snapshot").textContent = "no snapshot yet";
    $("session-expires").textContent = "";
    return;
  }
  $("session-executions").textContent = String(info.executions ?? 0);
  $("session-cwd").textContent = info.cwd || "/workspace";
  $("session-snapshot").textContent = info.snapshot
    ? `${info.snapshot.pages} snapshot page(s)${info.snapshot.stale ? " (stale)" : ""}`
    : "no snapshot yet";
  $("session-expires").textContent =
    typeof info.expiresAt === "number"
      ? `expires ${relativeTime(info.expiresAt)}`
      : "";
}

function resultText(response) {
  if (response.error)
    return `${response.error.name}: ${response.error.message}`;
  const result = response.results?.[0];
  if (!result) return "(no result)";
  return result.json !== undefined ? JSON.stringify(result.json) : result.text;
}

function selectedCellFor(sid) {
  const list = cells[sid] ?? [];
  const cell = list.find((c) => c.id === selectedCellId[sid]);
  return cell ?? list.at(-1);
}

function updateMetricsFromCell(cell) {
  $("log-count").textContent = cell
    ? String((cell.stdout?.length ?? 0) + (cell.stderr?.length ?? 0))
    : "0";
  $("metrics").children[0].textContent =
    cell?.durationMs !== undefined
      ? `${cell.durationMs.toFixed(1)} ms`
      : "— ms";
  $("metrics").children[1].textContent = cell?.response?.usage
    ? `${cell.response.usage.fuelConsumed.toLocaleString()} / ${cell.response.usage.fuelLimit.toLocaleString()} fuel`
    : "— fuel";
}

function displayReplSelection() {
  const sid = sessionIdFor(language);
  const cell = selectedCellFor(sid);
  const out = $("output");
  updateMetricsFromCell(cell);
  if (!cell) {
    out.textContent = "Evaluate a line to see the result.";
    return;
  }
  out.replaceChildren();
  const pre = document.createElement("pre");
  if (tab === "console") {
    const stdout = cell.stdout ?? [];
    const stderr = cell.stderr ?? [];
    if (!stdout.length && !stderr.length) {
      pre.textContent = "No console output.";
      pre.className = "muted";
      out.append(pre);
    }
    for (const text of stdout) out.append(logRow("stdout", text, false));
    for (const text of stderr) out.append(logRow("stderr", text, true));
  } else if (tab === "raw") {
    if (cell.response) {
      pre.textContent = JSON.stringify(cell.response, null, 2);
    } else {
      pre.textContent =
        cell.status === "pending"
          ? "Evaluating…"
          : "No JSON payload available (restored from local storage).";
      pre.className = "muted";
    }
    out.append(pre);
  } else if (cell.status === "pending") {
    pre.textContent = "Evaluating…";
    pre.className = "muted";
    out.append(pre);
  } else if (cell.isError) {
    if (cell.response?.error) {
      const { name, message, traceback } = cell.response.error;
      pre.textContent = [`${name}: ${message}`, ...(traceback ?? [])].join(
        "\n",
      );
    } else {
      pre.textContent = cell.resultText;
    }
    pre.className = "error";
    out.append(pre);
  } else if (!cell.resultText || cell.resultText === "(no result)") {
    pre.textContent = "No result (the last expression was undefined/None).";
    pre.className = "muted";
    out.append(pre);
  } else {
    pre.textContent = cell.resultText;
    out.append(pre);
  }
}

function buildCellElement(sid, cell) {
  const el = document.createElement("div");
  el.className = `repl-cell${cell.isError ? " error" : ""}${
    selectedCellId[sid] === cell.id ? " selected" : ""
  }`;
  const promptRow = document.createElement("div");
  promptRow.className = "repl-cell-prompt";
  const gutter = document.createElement("span");
  gutter.className = "repl-gutter";
  gutter.textContent = "›";
  const code = document.createElement("pre");
  code.className = "repl-code";
  code.textContent = cell.code;
  promptRow.append(gutter, code);
  el.append(promptRow);
  for (const text of cell.stdout ?? []) {
    const line = document.createElement("pre");
    line.className = "repl-stdout";
    line.textContent = text;
    el.append(line);
  }
  for (const text of cell.stderr ?? []) {
    const line = document.createElement("pre");
    line.className = "repl-stderr";
    line.textContent = text;
    el.append(line);
  }
  const resultRow = document.createElement("div");
  resultRow.className = "repl-result";
  if (cell.status === "pending") {
    resultRow.classList.add("pending");
    resultRow.textContent = "… evaluating";
  } else {
    const pre = document.createElement("pre");
    if (cell.isError) {
      if (cell.response?.error) {
        const { name, message, traceback } = cell.response.error;
        pre.textContent = [`${name}: ${message}`, ...(traceback ?? [])].join(
          "\n",
        );
      } else {
        pre.textContent = cell.resultText;
      }
      pre.className = "error";
    } else if (!cell.resultText || cell.resultText === "(no result)") {
      pre.textContent = "(no result)";
      pre.className = "muted";
    } else {
      pre.textContent = `=> ${cell.resultText}`;
      pre.className = "repl-value";
    }
    resultRow.append(pre);
    if (cell.durationMs !== undefined) {
      const dur = document.createElement("span");
      dur.className = "repl-duration";
      dur.textContent = `${cell.durationMs.toFixed(1)} ms`;
      resultRow.append(dur);
    }
  }
  el.append(resultRow);
  el.onclick = () => selectCell(sid, cell.id);
  return el;
}

function renderReplLog(sid, scrollToEnd) {
  const container = $("repl-log");
  if (!container) return;
  const list = cells[sid] ?? [];
  container.replaceChildren();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "muted repl-empty";
    empty.textContent =
      replEmptyHints[language] ?? "Press Enter to evaluate the line.";
    container.append(empty);
  } else {
    for (const cell of list) container.append(buildCellElement(sid, cell));
  }
  if (scrollToEnd) container.scrollTop = container.scrollHeight;
}

function selectCell(sid, cellId) {
  const list = cells[sid] ?? [];
  selectedCellId[sid] = cellId;
  followLatest[sid] = list.length > 0 && list[list.length - 1].id === cellId;
  renderReplLog(sid, false);
  if (!(effectiveMode() === "repl" && sessionIdFor(language) === sid)) return;
  const cell = list.find((c) => c.id === cellId);
  if (cell) {
    $("status").textContent =
      cell.status === "pending"
        ? "Evaluating…"
        : cell.isError
          ? "Execution failed"
          : "✓ Completed";
  }
  display();
}

function submitReplLine() {
  if (effectiveMode() !== "repl") return;
  const code = editor.state.doc.toString();
  if (!code.trim()) return;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: "" },
  });
  historyCursor = null;
  historyDraft = "";
  runReplCell(code);
  editor.focus();
}

async function runReplCell(code) {
  let envVars;
  try {
    envVars = parseEnvVars($("env-vars").value);
  } catch {
    $("status").textContent = "Invalid env vars JSON";
    $("env-vars").focus();
    return;
  }
  const gen = generation;
  const lang = language;
  const sid = sessionIdFor(lang);
  const cell = {
    id: ++cellSeq,
    code,
    status: "pending",
    response: undefined,
    resultText: "",
    stdout: [],
    stderr: [],
    isError: false,
    durationMs: undefined,
  };
  const list = cells[sid] ?? (cells[sid] = []);
  list.push(cell);
  while (list.length > MAX_CELLS) list.shift();
  if (followLatest[sid] !== false) selectedCellId[sid] = cell.id;
  $("status").textContent = "Evaluating…";
  if (language === lang && sessionIds[lang] === sid) {
    renderReplLog(sid, followLatest[sid] !== false);
    if (selectedCellId[sid] === cell.id) display();
  }
  const url = `/languages/${lang}/sessions/${sid}/execute`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, envVars }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.headers.get("content-type")?.includes("application/json"))
      throw new Error(`Worker returned HTTP ${res.status}`);
    const response = await res.json();
    Object.assign(cell, {
      status: "done",
      response,
      resultText: resultText(response),
      stdout: response.logs?.stdout ?? [],
      stderr: response.logs?.stderr ?? [],
      isError: !!response.error,
      durationMs: response.durationMs,
    });
  } catch (error) {
    Object.assign(cell, {
      status: "done",
      response: undefined,
      resultText: `${error.name}: ${error.message}`,
      stdout: [],
      stderr: [],
      isError: true,
      durationMs: undefined,
    });
  }
  persist();
  if (generation !== gen || language !== lang || sessionIds[lang] !== sid)
    return; // stale
  renderReplLog(sid, followLatest[sid] !== false);
  $("status").textContent = cell.isError ? "Execution failed" : "✓ Completed";
  if (selectedCellId[sid] === cell.id) display();
  refreshSessionInfo();
}

$("session-new").onclick = async () => {
  generation++;
  const lang = language;
  const old = sessionIds[lang];
  if (old) {
    try {
      await fetch(sessionBaseUrl(lang, old), { method: "DELETE" });
    } catch {}
    delete cells[old];
    delete selectedCellId[old];
    delete followLatest[old];
  }
  sessionIds[lang] = newSessionId();
  const sid = sessionIds[lang];
  cells[sid] = [];
  selectedCellId[sid] = undefined;
  followLatest[sid] = true;
  historyCursor = null;
  historyDraft = "";
  persist();
  workspaceOpenPath = null;
  $("status").textContent = "New session started";
  renderReplLog(sid, true);
  renderSessionStrip(null);
  display();
  await refreshSessionInfo();
};

$("session-reset").onclick = async () => {
  generation++;
  const lang = language;
  const sid = sessionIdFor(lang);
  try {
    await fetch(`${sessionBaseUrl(lang, sid)}/reset`, { method: "POST" });
  } catch {}
  cells[sid] = [];
  selectedCellId[sid] = undefined;
  followLatest[sid] = true;
  historyCursor = null;
  historyDraft = "";
  persist();
  workspaceOpenPath = null;
  $("status").textContent = "Session reset";
  renderReplLog(sid, true);
  display();
  await refreshSessionInfo();
};

// ---- Workspace tab ----------------------------------------------------

async function sessionFilesOp(lang, sid, body) {
  const res = await fetch(`${sessionBaseUrl(lang, sid)}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json;
}

function renderWorkspacePanel(out) {
  if (!out.querySelector(".workspace-panel")) {
    out.replaceChildren();
    const panel = document.createElement("div");
    panel.className = "workspace-panel";

    const toolbar = document.createElement("div");
    toolbar.className = "workspace-toolbar";
    const label = document.createElement("span");
    label.className = "section-label";
    label.textContent = "/workspace";
    const refreshBtn = document.createElement("button");
    refreshBtn.id = "workspace-refresh";
    refreshBtn.className = "quiet";
    refreshBtn.textContent = "Refresh";
    refreshBtn.onclick = () => loadWorkspace();
    toolbar.append(label, refreshBtn);

    const list = document.createElement("div");
    list.id = "workspace-list";
    list.className = "workspace-list";

    const newFile = document.createElement("div");
    newFile.className = "workspace-new";
    const newLabel = document.createElement("span");
    newLabel.className = "section-label";
    newLabel.textContent = "New / overwrite file";
    const nameInput = document.createElement("input");
    nameInput.id = "workspace-new-name";
    nameInput.type = "text";
    nameInput.placeholder = "/workspace/notes.txt";
    const contentArea = document.createElement("textarea");
    contentArea.id = "workspace-new-content";
    contentArea.placeholder = "File contents…";
    const saveBtn = document.createElement("button");
    saveBtn.id = "workspace-new-save";
    saveBtn.className = "quiet";
    saveBtn.textContent = "Create / overwrite";
    saveBtn.onclick = () =>
      writeWorkspaceFile(nameInput.value.trim(), contentArea.value);
    newFile.append(newLabel, nameInput, contentArea, saveBtn);

    const view = document.createElement("div");
    view.id = "workspace-file-view";
    view.className = "workspace-file-view";
    view.hidden = true;

    panel.append(toolbar, list, newFile, view);
    out.append(panel);
  }
  loadWorkspace();
}

async function loadWorkspace() {
  const lang = language;
  const sid = sessionIdFor(lang);
  const list = $("workspace-list");
  if (!list) return;
  list.textContent = "Loading…";
  try {
    const result = await sessionFilesOp(lang, sid, {
      op: "list",
      path: "/workspace",
      recursive: true,
    });
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    renderWorkspaceList(result.entries ?? []);
  } catch (error) {
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    list.textContent = `Could not load workspace: ${error.message}`;
  }
}

function renderWorkspaceList(entries) {
  const list = $("workspace-list");
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No files yet.";
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "workspace-entry";
    const name = document.createElement("button");
    name.className = "workspace-entry-name";
    name.textContent = entry.path + (entry.type === "directory" ? "/" : "");
    if (entry.type === "file")
      name.onclick = () => openWorkspaceFile(entry.path);
    else name.disabled = true;
    const size = document.createElement("span");
    size.className = "workspace-entry-size";
    size.textContent = entry.type === "file" ? `${entry.size}B` : "";
    row.append(name, size);
    list.append(row);
  }
}

async function openWorkspaceFile(path) {
  const lang = language;
  const sid = sessionIdFor(lang);
  try {
    const result = await sessionFilesOp(lang, sid, { op: "read", path });
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    workspaceOpenPath = path;
    const view = $("workspace-file-view");
    view.hidden = false;
    view.replaceChildren();
    const heading = document.createElement("div");
    heading.id = "workspace-file-name";
    heading.className = "section-label";
    heading.textContent = path;
    const textarea = document.createElement("textarea");
    textarea.id = "workspace-file-content";
    textarea.value = result.isBinary
      ? "(binary file — editing unsupported)"
      : result.content;
    textarea.disabled = result.isBinary;
    const actions = document.createElement("div");
    actions.className = "workspace-file-actions";
    const saveBtn = document.createElement("button");
    saveBtn.id = "workspace-file-save";
    saveBtn.className = "quiet";
    saveBtn.textContent = "Save";
    saveBtn.disabled = result.isBinary;
    saveBtn.onclick = () => writeWorkspaceFile(path, textarea.value);
    const deleteBtn = document.createElement("button");
    deleteBtn.id = "workspace-file-delete";
    deleteBtn.className = "quiet";
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = () => deleteWorkspaceFile(path);
    actions.append(saveBtn, deleteBtn);
    view.append(heading, textarea, actions);
  } catch (error) {
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    $("status").textContent = `Could not open ${path}: ${error.message}`;
  }
}

async function writeWorkspaceFile(path, content) {
  if (!path) {
    $("status").textContent = "File name is required";
    return;
  }
  const lang = language;
  const sid = sessionIdFor(lang);
  try {
    await sessionFilesOp(lang, sid, { op: "write", path, content });
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    $("status").textContent = `Saved ${path}`;
    await loadWorkspace();
  } catch (error) {
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    $("status").textContent = `Could not save ${path}: ${error.message}`;
  }
}

async function deleteWorkspaceFile(path) {
  const lang = language;
  const sid = sessionIdFor(lang);
  try {
    await sessionFilesOp(lang, sid, { op: "delete", path });
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    if (workspaceOpenPath === path) {
      workspaceOpenPath = null;
      $("workspace-file-view").hidden = true;
    }
    $("status").textContent = `Deleted ${path}`;
    await loadWorkspace();
  } catch (error) {
    if (!(language === lang && sessionIds[lang] === sid)) return; // stale
    $("status").textContent = `Could not delete ${path}: ${error.message}`;
  }
}

fetch("/languages")
  .then((res) => {
    if (!res.ok) throw new Error("Cannot load runtimes");
    return res.json();
  })
  .then(({ languages }) => {
    $("language").replaceChildren(
      ...languages
        .filter((language) => language.enabled)
        .map((language) => {
          const option = document.createElement("option");
          option.value = language.id;
          option.textContent = language.name;
          return option;
        }),
    );
    const initial = library[requestedLanguage]
      ? requestedLanguage
      : library[saved?.language]
        ? saved.language
        : "javascript";
    $("language").value = initial;
    switchLanguage(initial, initial !== requestedLanguage);
  })
  .catch(() => {
    $("status").textContent = "Runtime discovery unavailable";
  });
