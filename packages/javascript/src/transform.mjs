// Runs in Workers V8 (the host), never inside the guest Wasm sandbox.
import * as acorn from "acorn";
const EMPTY = "(async () => {})()";
/**
 * Turns a script into an async IIFE whose return value is the value of the
 * last top-level expression statement, so callers see "code is a script,
 * the last expression is the result" without any persistent context.
 */
export function transformForAsyncExecution(code) {
  if (!code || !code.trim()) return EMPTY;
  let program;
  try {
    program = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    // Let SpiderMonkey report the real SyntaxError inside the guest.
    return `(async () => {\n${code}\n})()`;
  }
  const body = program.body;
  const last = body.at(-1);
  let statements = code;
  if (last && last.type === "ExpressionStatement") {
    const before = code.slice(0, last.start);
    const exprText = code.slice(last.start, last.end).replace(/;\s*$/, "");
    statements = `${before}return (${exprText})`;
  }
  return `(async () => {\n${statements}\n})()`;
}
