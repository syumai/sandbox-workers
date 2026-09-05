// Runs in Workers V8 (the host), never inside the guest Wasm sandbox.
import * as acorn from "acorn";
const EMPTY = "(async () => {})()";
const ILLEGAL_RETURN =
  '(async () => { throw new SyntaxError("Illegal return statement"); })()';
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
    });
  } catch {
    // acorn rejected the code. A top-level `return` is a common cause (the
    // SDK no longer allows it); detect that specifically by re-parsing with
    // returns allowed and checking whether one appears at the top level, so
    // we can report a clear guest-side SyntaxError instead of whatever
    // unrelated parse error acorn produces without allowReturnOutsideFunction.
    if (hasTopLevelReturn(code)) return ILLEGAL_RETURN;
    // Otherwise let SpiderMonkey report the real SyntaxError inside the guest.
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
