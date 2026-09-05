// Runs in Workers V8 (the host), never inside the guest Wasm sandbox.
import * as acorn from "acorn";
// Import sucrase's core transform entry (its package "main"), not a
// CLI-specific path, so only the TypeScript-stripping code path is
// reachable from this module's import graph: sucrase's separate CLI
// entry points (bin/sucrase, dist/cli.js) and their extra dependencies
// (commander, mz, pirates, tinyglobby) are never referenced and so never
// get bundled by esbuild.
import { transform as sucraseTransform } from "sucrase";
const EMPTY = "(async () => {})()";
const ILLEGAL_RETURN =
  '(async () => { throw new SyntaxError("Illegal return statement"); })()';
/**
 * Turns a script into an async IIFE whose return value is the value of the
 * last top-level expression statement, so callers see "code is a script,
 * the last expression is the result" without any persistent context.
 *
 * JavaScript is always tried first with acorn: any code that is valid
 * JavaScript keeps JavaScript semantics unchanged (e.g. `a < b > (c)` is
 * never reinterpreted as a generic function call). Only code acorn rejects
 * (and that isn't a top-level `return`) is given to sucrase to strip
 * TypeScript-only syntax; sucrase performs no type checking, it only
 * removes types, so a TypeScript type error still runs like any other
 * dynamically-typed JavaScript mistake. `import`/`export` remain
 * unsupported (there is no module system in the guest); `enum`, `namespace`,
 * and parameter properties are rewritten by sucrase's transform.
 */
export function transformForAsyncExecution(code) {
  if (!code || !code.trim()) return EMPTY;
  const program = tryParseJavaScript(code);
  if (program) return applyLastExpression(code, program);
  // acorn rejected the code as JavaScript. A top-level `return` is a common
  // cause (the SDK no longer allows it); detect that specifically by
  // re-parsing with returns allowed and checking whether one appears at the
  // top level, so we can report a clear guest-side SyntaxError instead of
  // whatever unrelated parse error acorn produces without
  // allowReturnOutsideFunction.
  if (hasTopLevelReturn(code)) return ILLEGAL_RETURN;
  let stripped;
  try {
    stripped = sucraseTransform(code, {
      transforms: ["typescript"],
      disableESTransforms: true,
    }).code;
  } catch {
    // Not valid TypeScript either. Let SpiderMonkey report the real
    // SyntaxError inside the guest, against the original code so the
    // reported error matches what the caller submitted.
    return `(async () => {\n${code}\n})()`;
  }
  const strippedProgram = tryParseJavaScript(stripped);
  if (strippedProgram) return applyLastExpression(stripped, strippedProgram);
  if (hasTopLevelReturn(stripped)) return ILLEGAL_RETURN;
  return `(async () => {\n${stripped}\n})()`;
}
function tryParseJavaScript(code) {
  try {
    return acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return null;
  }
}
function applyLastExpression(code, program) {
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
/**
 * Detects whether `code` contains a `return` statement reachable from the
 * top level (i.e. not inside a nested function/arrow/class). Walks only
 * statement-holding constructs a top-level return could appear under
 * (blocks, if, for/for-in/for-of, while, do-while, try/catch/finally,
 * switch, labeled statements) and stops descending at any function-like or
 * class boundary.
 */
function hasTopLevelReturn(code) {
  let program;
  try {
    program = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    // Still unparsable even with returns allowed: not a top-level-return issue.
    return false;
  }
  return program.body.some(statementHasReturn);
}
function statementHasReturn(node) {
  if (!node || typeof node.type !== "string") return false;
  switch (node.type) {
    case "ReturnStatement":
      return true;
    case "BlockStatement":
      return node.body.some(statementHasReturn);
    case "IfStatement":
      return (
        statementHasReturn(node.consequent) ||
        statementHasReturn(node.alternate)
      );
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
      return statementHasReturn(node.body);
    case "TryStatement":
      return (
        statementHasReturn(node.block) ||
        (node.handler && statementHasReturn(node.handler.body)) ||
        statementHasReturn(node.finalizer)
      );
    case "SwitchStatement":
      return node.cases.some((c) => c.consequent.some(statementHasReturn));
    case "LabeledStatement":
      return statementHasReturn(node.body);
    // Function/Arrow/Class boundaries: a `return` inside these belongs to
    // that nested scope, not the top level, so do not descend into them.
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
    default:
      return false;
  }
}
