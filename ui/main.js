import { Compartment } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import pyHello from "../examples/python/hello.py?raw";
import pyStdlib from "../examples/python/stdlib.py?raw";
import pySession from "../examples/python/session.py?raw";
import plHello from "../examples/perl/hello.pl?raw";
import plRegex from "../examples/perl/regex.pl?raw";
import plSession from "../examples/perl/session.pl?raw";
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
import session from "../examples/session.js?raw";
import "./style.css";
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "sandbox-workers-playground-v2";
const MAX_TRANSCRIPT = 20;
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
  { name: "Session demo", code: session, envVars: {} },
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
    { name: "Session demo", code: pySession, envVars: {} },
  ],
  perl: [
    { name: "Hello, Perl", code: plHello, envVars: { NAME: "world" } },
    {
      name: "Regular expressions",
      code: plRegex,
      envVars: { WORDS: "hello,world,hello,perl" },
    },
    { name: "Session demo", code: plSession, envVars: {} },
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
  javascript: 'const x = Number(process.env.X);\nx ** 2',
  python: 'import os\nx = int(os.environ["X"])\nx ** 2',
  perl: "my $x = $ENV{X};\n$x ** 2",
  ruby: 'x = ENV["X"].to_i\nx ** 2',
};
const syntax = new Compartment();
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
// Session mode (see website/content/guides/playground.md "Session mode").
// `userMode` is the mode the user picked; Ruby has no session mode, so the
// *effective* mode (effectiveMode()) forces "script" there without losing
// the user's preference for the other languages. `sessionIds` maps each
// language to one Playground-generated sandbox id, persisted (under
// `sandboxIds`; the old `sessionIds` key is ignored) so the same browser
// reuses it across visits. `transcripts` (in-memory only, cleared on New
// session / Reset) maps a sandbox id to its last MAX_TRANSCRIPT
// {code, text, isError} entries.
let userMode = saved?.mode === "session" ? "session" : "script";
let sessionIds =
  saved?.sandboxIds && typeof saved.sandboxIds === "object" && !Array.isArray(saved.sandboxIds)
    ? { ...saved.sandboxIds }
    : {};
let transcripts = {};
let workspaceOpenPath = null;
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
const editor = new EditorView({
  doc: typeof saved?.code === "string" ? saved.code : hello,
  extensions: [
    basicSetup,
    syntax.of(modes.javascript),
    oneDark,
    EditorView.lineWrapping,
    keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          run();
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        $("dirty").textContent = "•";
        persist();
      }
    }),
  ],
  parent: $("editor"),
});
if (typeof saved?.envVars === "string") $("env-vars").value = saved.envVars;
function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        language,
        code: editor.state.doc.toString(),
        envVars: $("env-vars").value,
        mode: userMode,
        sandboxIds: sessionIds,
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
function renderExamples() {
  $("examples").replaceChildren();
  examples.forEach((example, i) => {
    const button = document.createElement("button");
    button.textContent = `${String(i + 1).padStart(2, "0")}  ${example.name}`;
    button.onclick = () => selectExample(i);
    button.className = i === 0 ? "active" : "";
    $("examples").append(button);
  });
  $("example-count").textContent = String(examples.length).padStart(2, "0");
}
function switchLanguage(next, restore = false) {
  language = next;
  examples = library[next];
  editor.dispatch({ effects: syntax.reconfigure(modes[next]) });
  renderExamples();
  selectExample(0);
  if (restore && typeof saved?.code === "string") {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: saved.code },
    });
    if (typeof saved.envVars === "string") $("env-vars").value = saved.envVars;
  }
  $("filename").textContent =
    `experiment.${{ javascript: "js", python: "py", perl: "pl", ruby: "rb" }[next]}`;
  $("env-name").textContent = envNames[next];
  $("editor").setAttribute("aria-label", `${next} code editor`);
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
  $("output").textContent = "Run your code to see the result.";
  $("status").textContent = "Ready";
  $("log-count").textContent = "0";
  persist();
  syncSessionUI();
}
renderExamples();
$("language").onchange = () => switchLanguage($("language").value);
$("mode-script").onclick = () => setMode("script");
$("mode-session").onclick = () => setMode("session");
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
    pre.textContent = [`${name}: ${message}`, ...(traceback ?? [])].join(
      "\n",
    );
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
    for (const t of TABS) $(t + "-tab").setAttribute("aria-selected", String(t === tab));
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
    if (typeof v !== "string") throw new Error("envVars values must be strings");
  return value;
}
async function run() {
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
  const sessionMode = effectiveMode() === "session";
  const code = editor.state.doc.toString();
  const url = sessionMode
    ? `/languages/${$("language").value}/sandboxes/${sessionIdFor(language)}/execute`
    : `/execute/${$("language").value}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, envVars }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.headers.get("content-type")?.includes("application/json"))
      throw new Error(`Worker returned HTTP ${res.status}`);
    response = await res.json();
    $("status").textContent = response.error
      ? "Execution failed"
      : "✓ Completed";
  } catch (error) {
    response = {
      error: { name: error.name, message: error.message, traceback: [] },
      logs: { stdout: [], stderr: [] },
      results: [],
    };
    $("status").textContent = "Request failed";
  } finally {
    busy = false;
    $("run").disabled = false;
  }
  $("log-count").textContent =
    (response.logs?.stdout?.length ?? 0) + (response.logs?.stderr?.length ?? 0);
  $("metrics").children[0].textContent =
    response.durationMs === undefined
      ? "— ms"
      : `${response.durationMs.toFixed(1)} ms`;
  $("metrics").children[1].textContent = response.usage
    ? `${response.usage.fuelConsumed.toLocaleString()} / ${response.usage.fuelLimit.toLocaleString()} fuel`
    : "— fuel";
  if (sessionMode) {
    addTranscriptEntry(code, response);
    await refreshSessionInfo();
  }
  display();
}

// ---- Session mode ---------------------------------------------------------
// See website/content/guides/playground.md "Session mode" and
// website/content/guides/sessions.md for the underlying HTTP contract.

function setMode(next) {
  if ($("mode-session").disabled) next = "script";
  userMode = next;
  persist();
  syncSessionUI();
}

// Reconciles every session-mode-dependent bit of the UI with the current
// language + userMode. Called after switchLanguage() and setMode().
function syncSessionUI() {
  const isRuby = language === "ruby";
  const isSession = effectiveMode() === "session";
  $("mode-script").setAttribute("aria-pressed", String(!isSession));
  $("mode-session").setAttribute("aria-pressed", String(isSession));
  $("mode-session").disabled = isRuby;
  $("mode-session").title = isRuby
    ? "Sessions are not available for Ruby"
    : "Run code in a durable, per-browser session";
  $("session-bar").hidden = !isSession;
  $("session-strip").hidden = !isSession;
  $("transcript").hidden = !isSession;
  $("workspace-tab").hidden = !isSession;
  $("editor-mode").textContent = `${language} · ${isSession ? "session" : "script"}`;
  if (!isSession && tab === "workspace") {
    tab = "result";
    for (const t of TABS) $(t + "-tab").setAttribute("aria-selected", String(t === tab));
  }
  if (isSession) {
    $("session-id").textContent = sessionIdFor(language);
    renderTranscript();
    renderSessionStrip(null);
    refreshSessionInfo();
  }
  display();
}

function sessionBaseUrl() {
  return `/languages/${language}/sandboxes/${sessionIdFor(language)}`;
}

async function refreshSessionInfo() {
  if (effectiveMode() !== "session") return;
  try {
    const res = await fetch(sessionBaseUrl());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderSessionStrip(await res.json());
  } catch {
    renderSessionStrip(null);
  }
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
  const ctx = info.contexts?.[0];
  $("session-executions").textContent = String(ctx?.executions ?? 0);
  $("session-cwd").textContent = ctx?.cwd || "/workspace";
  $("session-snapshot").textContent = ctx?.snapshot
    ? `${ctx.snapshot.pages} snapshot page(s)${ctx.snapshot.stale ? " (stale)" : ""}`
    : "no snapshot yet";
  $("session-expires").textContent =
    typeof info.expiresAt === "number" ? `expires ${relativeTime(info.expiresAt)}` : "";
}

function resultText(response) {
  if (response.error) return `${response.error.name}: ${response.error.message}`;
  const result = response.results?.[0];
  if (!result) return "(no result)";
  return result.json !== undefined ? JSON.stringify(result.json) : result.text;
}

function addTranscriptEntry(code, response) {
  const id = sessionIdFor(language);
  const list = transcripts[id] ?? (transcripts[id] = []);
  list.push({ code, text: resultText(response), isError: !!response.error });
  while (list.length > MAX_TRANSCRIPT) list.shift();
  renderTranscript();
}

function renderTranscript() {
  const list = transcripts[sessionIdFor(language)] ?? [];
  const container = $("transcript");
  container.replaceChildren();
  list.forEach((entry, i) => {
    const details = document.createElement("details");
    details.className = `transcript-entry${entry.isError ? " error" : ""}`;
    const summary = document.createElement("summary");
    summary.textContent = `#${i + 1}  ${entry.code.split("\n")[0].slice(0, 60)}`;
    const codePre = document.createElement("pre");
    codePre.textContent = entry.code;
    const resultPre = document.createElement("pre");
    resultPre.className = entry.isError ? "error" : "muted";
    resultPre.textContent = entry.text;
    details.append(summary, codePre, resultPre);
    container.append(details);
  });
}

$("session-new").onclick = async () => {
  const old = sessionIds[language];
  if (old) {
    try {
      await fetch(`/languages/${language}/sandboxes/${old}`, { method: "DELETE" });
    } catch {}
    delete transcripts[old];
  }
  sessionIds[language] = newSessionId();
  persist();
  workspaceOpenPath = null;
  $("status").textContent = "New session started";
  renderTranscript();
  renderSessionStrip(null);
  await refreshSessionInfo();
};

$("session-reset").onclick = async () => {
  const id = sessionIdFor(language);
  try {
    const res = await fetch(`${sessionBaseUrl()}/contexts`);
    const { contexts } = await res.json();
    for (const context of contexts ?? [])
      await fetch(`${sessionBaseUrl()}/contexts/${encodeURIComponent(context.id)}`, {
        method: "DELETE",
      });
  } catch {}
  transcripts[id] = [];
  workspaceOpenPath = null;
  $("status").textContent = "Session reset";
  renderTranscript();
  await refreshSessionInfo();
};

// ---- Workspace tab ----------------------------------------------------

async function sessionFilesOp(body) {
  const res = await fetch(`${sessionBaseUrl()}/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
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
    saveBtn.onclick = () => writeWorkspaceFile(nameInput.value.trim(), contentArea.value);
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
  const list = $("workspace-list");
  if (!list) return;
  list.textContent = "Loading…";
  try {
    const result = await sessionFilesOp({ op: "list", path: "/workspace", recursive: true });
    renderWorkspaceList(result.files ?? []);
  } catch (error) {
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
    name.textContent = entry.absolutePath + (entry.type === "directory" ? "/" : "");
    if (entry.type === "file") name.onclick = () => openWorkspaceFile(entry.absolutePath);
    else name.disabled = true;
    const size = document.createElement("span");
    size.className = "workspace-entry-size";
    size.textContent = entry.type === "file" ? `${entry.size}B` : "";
    row.append(name, size);
    list.append(row);
  }
}

async function openWorkspaceFile(path) {
  try {
    const result = await sessionFilesOp({ op: "read", path });
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
    textarea.value = result.isBinary ? "(binary file — editing unsupported)" : result.content;
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
    $("status").textContent = `Could not open ${path}: ${error.message}`;
  }
}

async function writeWorkspaceFile(path, content) {
  if (!path) {
    $("status").textContent = "File name is required";
    return;
  }
  try {
    await sessionFilesOp({ op: "write", path, content });
    $("status").textContent = `Saved ${path}`;
    await loadWorkspace();
  } catch (error) {
    $("status").textContent = `Could not save ${path}: ${error.message}`;
  }
}

async function deleteWorkspaceFile(path) {
  try {
    await sessionFilesOp({ op: "delete", path });
    if (workspaceOpenPath === path) {
      workspaceOpenPath = null;
      $("workspace-file-view").hidden = true;
    }
    $("status").textContent = `Deleted ${path}`;
    await loadWorkspace();
  } catch (error) {
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
