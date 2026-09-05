import { Compartment } from "@codemirror/state";
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
import "./style.css";
const $ = (id) => document.getElementById(id);
const javascriptExamples = [
  { name: "Hello, sandbox", code: hello, envVars: { NAME: "world" } },
  { name: "Modern JavaScript", code: modern, envVars: {} },
  {
    name: "Transform data",
    code: transform,
    envVars: { WORDS: "Books,Tools,Books,Books,Tools" },
  },
  { name: "Intl formatting", code: intl, envVars: {} },
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
  javascript: 'const x = Number(process.env.X);\nx ** 2',
  python: 'import os\nx = int(os.environ["X"])\nx ** 2',
  perl: "my $x = $ENV{X};\n$x ** 2",
  ruby: 'x = ENV["X"].to_i\nx ** 2',
};
const syntax = new Compartment();
const modes = {
  javascript: javascript(),
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
  saved = JSON.parse(
    localStorage.getItem("sandbox-workers-playground-v2") ?? "null",
  );
} catch {}
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
      "sandbox-workers-playground-v2",
      JSON.stringify({
        language,
        code: editor.state.doc.toString(),
        envVars: $("env-vars").value,
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
  $("editor-mode").textContent = `${next} · script`;
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
    `import { createSandbox } from "@sandbox-workers/core";\n\nconst sandbox = createSandbox(env.SANDBOX, "${next}");\nconst output = await sandbox.runCode(\n  ${JSON.stringify(clientSnippets[next])},\n  { envVars: { X: "12" } },\n);\n// { results: [{ text: "144" }], ... }`;
  response = undefined;
  $("output").textContent = "Run your code to see the result.";
  $("status").textContent = "Ready";
  $("log-count").textContent = "0";
  persist();
}
renderExamples();
$("language").onchange = () => switchLanguage($("language").value);
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
  if (!response) return;
  const out = $("output");
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
for (const name of ["result", "console", "raw"])
  $(name + "-tab").onclick = () => {
    tab = name;
    for (const t of ["result", "console", "raw"])
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
  try {
    const res = await fetch("/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        language: $("language").value,
        code: editor.state.doc.toString(),
        envVars,
      }),
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
  display();
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
