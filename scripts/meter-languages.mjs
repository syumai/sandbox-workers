import { instrument } from "./instrument.mjs";
for (const language of process.argv.slice(2)) {
  if (!["python", "perl", "ruby"].includes(language))
    throw new Error("Unsupported runtime: " + language);
  const path =
    language === "ruby"
      ? "node_modules/@ruby/4.0-wasm-wasi/dist/ruby+stdlib.wasm"
      : `engine/.build/languages/${language}.wasm`;
  console.log("Instrumenting", language);
  await instrument(
    path,
    `packages/${language}/dist/engine.wasm`,
    language === "ruby" ? 1536 : 1024,
  );
}
