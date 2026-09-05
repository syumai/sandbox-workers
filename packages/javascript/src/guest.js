// This program is snapshotted with the complete Fastly SpiderMonkey engine.
addEventListener("fetch", (event) => event.respondWith(execute(event.request)));
class ExecutionLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExecutionLimitError";
  }
}
async function execute(request) {
  const { code, envVars } = await request.json();
  globalThis.process = Object.freeze({ env: Object.freeze({ ...envVars }) });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  const format = (value) =>
    typeof value === "string"
      ? value
      : typeof value === "bigint"
        ? `${value}n`
        : (JSON.stringify(value) ?? String(value));
  const capture = (list) => (...args) => {
    // One entry per console call, like today; strip a single trailing
    // newline so a stray console.log("x\n") matches the WASI languages'
    // line-per-entry logs instead of leaving a blank line in the array.
    const text = args.map(format).join(" ").replace(/\n$/, "");
    bytes += text.length;
    if (stdout.length + stderr.length >= 200 || bytes > 32768)
      throw new ExecutionLimitError("Output limit exceeded");
    list.push(text);
  };
  console.log = console.info = console.debug = capture(stdout);
  console.warn = console.error = capture(stderr);
  const quote = (value) =>
    `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const formatText = (value) => {
    if (typeof value === "string") return quote(value);
    if (typeof value === "bigint") return `${value}n`;
    return String(value);
  };
  const mapResult = (value) => {
    if (value === undefined) return [];
    let entry;
    if (typeof value === "object" && value !== null) {
      const json = JSON.parse(
        JSON.stringify(value, (_, v) =>
          typeof v === "bigint" ? `${v}n` : v,
        ),
      );
      entry = { json };
    } else {
      entry = { text: formatText(value) };
    }
    const size = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (size > 65536) throw new ExecutionLimitError("Result limit exceeded");
    return [entry];
  };
  try {
    // Dynamic compilation happens INSIDE SpiderMonkey/Wasm, never in Workers V8.
    const value = await (0, eval)(code);
    return Response.json({
      logs: { stdout, stderr },
      results: mapResult(value),
    });
  } catch (error) {
    return Response.json({
      logs: { stdout, stderr },
      results: [],
      error: {
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error),
        traceback: String(error?.stack ?? "")
          .slice(0, 8192)
          .split("\n"),
      },
    });
  }
}
