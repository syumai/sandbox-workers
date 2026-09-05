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
import web from "../examples/web-apis.js?raw";
import "./style.css";
const $ = (id) => document.getElementById(id);
const javascriptExamples = [
  { name: "Hello, sandbox", code: hello, input: { name: "world" } },
  { name: "Modern JavaScript", code: modern, input: {} },
  { name: "Transform data", code: transform, input: {} },
  { name: "Web primitives", code: web, input: {} },
];
const library = {
  javascript: javascriptExamples,
  python: [
    { name: "Hello, Python", code: pyHello, input: { name: "world" } },
    {
      name: "Standard library",
      code: pyStdlib,
      input: { words: ["hello", "world", "hello"] },
    },
  ],
  perl: [
    { name: "Hello, Perl", code: plHello, input: { name: "world" } },
    {
      name: "Regular expressions",
      code: plRegex,
      input: { text: "Hello world! Hello Perl." },
    },
  ],
  ruby: [
    { name: "Hello, Ruby", code: rbHello, input: { name: "world" } },
    {
      name: "Enumerable",
      code: rbEnumerable,
      input: { words: ["ruby", "wasm", "hi", "workers"] },
    },
  ],
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
    localStorage.getItem("sandbox-workers-playground") ??
      // Read the previous storage key so existing drafts survive the rename.
      localStorage.getItem("wasm-lab") ??
      "null",
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
if (typeof saved?.input === "string") $("input").value = saved.input;
function persist() {
  try {
    localStorage.setItem(
      "sandbox-workers-playground",
      JSON.stringify({
        language,
        code: editor.state.doc.toString(),
        input: $("input").value,
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
  $("input").value = JSON.stringify(e.input, null, 2);
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
    if (typeof saved.input === "string") $("input").value = saved.input;
  }
  $("filename").textContent =
    `experiment.${{ javascript: "js", python: "py", perl: "pl", ruby: "rb" }[next]}`;
  $("editor-mode").textContent =
    `${next} · ${next === "javascript" ? "async function" : "function"} body`;
  $("input-name").textContent = next === "perl" ? "$input" : "input";
  $("editor").setAttribute("aria-label", `${next} code editor`);
  $("install-command").textContent =
    `pnpm dlx @sandbox-workers/cli init ${next} my-sandbox\ncd my-sandbox\npnpm install\npnpm dry-run\npnpm run deploy`;
  $("binding-command").textContent = JSON.stringify(
    { services: [{ binding: "SANDBOX", service: `sandbox-${next}` }] },
    null,
    2,
  );
  $("client-command").textContent =
    `import { createSandbox } from "@sandbox-workers/core";\n\nconst sandbox = createSandbox(env.SANDBOX, "${next}");\nconst output = await sandbox.execute({\n  code: ${JSON.stringify(examples[0].code)},\n  input: { name: "world" },\n});`;
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
$("input").oninput = persist;
$("reset").onclick = () => selectExample(selected);
$("run").onclick = run;
function display() {
  if (!response) return;
  const out = $("output");
  out.replaceChildren();
  const pre = document.createElement("pre");
  if (tab === "console") {
    if (!response.logs?.length) {
      pre.textContent = "No console output.";
      pre.className = "muted";
      out.append(pre);
    }
    for (const log of response.logs ?? []) {
      const row = document.createElement("div");
      row.className = `log ${["error", "warn"].includes(log.level) ? log.level : ""}`;
      const label = document.createElement("span");
      label.textContent = log.level;
      const text = document.createElement("pre");
      text.textContent = log.text;
      row.append(label, text);
      out.append(row);
    }
  } else {
    pre.textContent = JSON.stringify(
      tab === "raw" ? response : response.ok ? response.result : response.error,
      null,
      2,
    );
    if (!response.ok) pre.className = "error";
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
async function run() {
  if (busy) return;
  let input;
  try {
    input = JSON.parse($("input").value || "null");
  } catch {
    $("status").textContent = "Invalid input JSON";
    $("input").focus();
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
        input,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.headers.get("content-type")?.includes("application/json"))
      throw new Error(`Worker returned HTTP ${res.status}`);
    response = await res.json();
    $("status").textContent = response.ok ? "✓ Completed" : "Execution failed";
  } catch (error) {
    response = {
      ok: false,
      error: { name: error.name, message: error.message },
      logs: [],
    };
    $("status").textContent = "Request failed";
  } finally {
    busy = false;
    $("run").disabled = false;
  }
  $("log-count").textContent = response.logs?.length ?? 0;
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
