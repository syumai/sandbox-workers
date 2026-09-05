// This program is snapshotted with the complete Fastly SpiderMonkey engine.
addEventListener("fetch", (event) => event.respondWith(execute(event.request)));
async function execute(request) {
  const { code, input } = await request.json();
  const logs = [];
  let bytes = 0;
  const format = (value) =>
    typeof value === "string"
      ? value
      : typeof value === "bigint"
        ? `${value}n`
        : (JSON.stringify(value) ?? String(value));
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => {
      const text = args.map(format).join(" ");
      bytes += text.length;
      if (logs.length >= 200 || bytes > 32768)
        throw new Error("Console output limit exceeded");
      logs.push({ level, text });
    };
  }
  try {
    // Dynamic compilation happens INSIDE SpiderMonkey/Wasm, never in Workers V8.
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    const value = await new AsyncFunction("input", code)(input);
    const result =
      value === undefined
        ? null
        : JSON.parse(
            JSON.stringify(value, (_, v) =>
              typeof v === "bigint" ? `${v}n` : v,
            ),
          );
    return Response.json({ ok: true, result, logs });
  } catch (error) {
    return Response.json({
      ok: false,
      error: {
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? "").slice(0, 8192),
      },
      logs,
    });
  }
}
