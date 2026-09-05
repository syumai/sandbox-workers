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
export { hasTopLevelReturn };

// ---- REPL transform (durable sessions) --------------------------------
//
// Unlike transformForAsyncExecution above (which always wraps the whole
// script in an async IIFE, so no declaration ever needs to persist), a
// session needs top-level `var`/`let`/`const`/`class`/`function` to persist
// on the real global object across executions. js_eval only gives that
// browser-console persistence to code it evaluates directly as a top-level
// classic script — so:
//
//  - When the code has no top-level `await`, only the last top-level
//    expression statement is rewritten (into a call that stashes its value),
//    and the REST OF THE SCRIPT IS LEFT AS TOP-LEVEL CODE, unwrapped, so
//    every declaration lands on the real global.
//  - When it does have a top-level `await`, the whole script must run inside
//    an async function (classic scripts cannot contain a genuine top-level
//    `await`). Node's REPL trick is used: hoist every top-level declared
//    name to a `var` on the (still top-level, still persistent) outer
//    scope, and rewrite each declaration, in place, into a plain assignment
//    to that name inside the async IIFE.
export function transformForRepl(code) {
  if (!code || !code.trim()) return { mode: "raw", code: "" };
  let program;
  try {
    program = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
    });
  } catch {
    // Unparsable outside of a top-level return: let SpiderMonkey report the
    // real SyntaxError directly against the guest's own code.
    return { mode: "raw", code };
  }
  // A top-level `return` never reaches here: it always fails the plain
  // acorn.parse above (a "script" never allows return outside a function),
  // so that case already fell into the `raw` fallback and will surface as a
  // genuine SyntaxError straight from js_eval, in both the capture and hoist
  // shapes below.
  const needsHoist = hasTopLevelAwait(program);
  if (!needsHoist) {
    const body = program.body;
    const last = body.at(-1);
    if (last && last.type === "ExpressionStatement") {
      const before = code.slice(0, last.start);
      const exprText = code.slice(last.start, last.end).replace(/;\s*$/, "");
      return { mode: "capture", code: `${before}globalThis.__sandboxSession.setResult(${exprText});` };
    }
    // No top-level `return` special-casing is needed here: a genuine
    // top-level `return` stays a real SyntaxError straight from js_eval,
    // because this path never wraps the code in a function.
    return { mode: "raw", code };
  }
  const hoisted = [];
  let bodyText = "";
  let cursor = 0;
  const body = program.body;
  body.forEach((node, i) => {
    bodyText += code.slice(cursor, node.start);
    cursor = node.end;
    if (node.type === "VariableDeclaration") {
      bodyText += rewriteVariableDeclaration(code, node, hoisted);
    } else if (
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
      node.id
    ) {
      hoisted.push(node.id.name);
      bodyText += `${toAssignment(code, node)};`;
    } else if (i === body.length - 1 && node.type === "ExpressionStatement") {
      const exprText = code.slice(node.start, node.end).replace(/;\s*$/, "");
      bodyText += `globalThis.__sandboxSession.setResult(${exprText});`;
    } else {
      bodyText += code.slice(node.start, node.end);
    }
  });
  bodyText += code.slice(cursor);
  const hoistLine = hoisted.length ? `var ${[...new Set(hoisted)].join(", ")};\n` : "";
  const wrapped = `${hoistLine}(async () => {\n  try {\n${bodyText}\n  } catch (__sandboxError) {\n    globalThis.__sandboxSession.setError(__sandboxError);\n  } finally {\n    globalThis.__sandboxSession.markDone();\n  }\n})();`;
  return { mode: "hoist", code: wrapped };
}

function toAssignment(code, node) {
  const name = node.id.name;
  const before = code.slice(node.start, node.id.start);
  const after = code.slice(node.id.end, node.end);
  return `${name} = ${before}${name}${after}`;
}

function rewriteVariableDeclaration(code, node, hoisted) {
  const parts = [];
  for (const decl of node.declarations) {
    collectNames(decl.id, hoisted);
    if (decl.init) {
      const idText = code.slice(decl.id.start, decl.id.end);
      const initText = code.slice(decl.init.start, decl.init.end);
      parts.push(`(${idText} = ${initText})`);
    }
  }
  return parts.length ? `${parts.join(", ")};` : "";
}

function collectNames(pattern, names) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") collectNames(prop.argument, names);
        else collectNames(prop.value, names);
      }
      break;
    case "ArrayPattern":
      for (const el of pattern.elements) {
        if (!el) continue;
        collectNames(el.type === "RestElement" ? el.argument : el, names);
      }
      break;
    case "AssignmentPattern":
      collectNames(pattern.left, names);
      break;
    case "RestElement":
      collectNames(pattern.argument, names);
      break;
  }
}

// Whether `program` contains an `await` (or `for await`) reachable from the
// top level. Walks generically over every node property that looks like an
// AST node/array of nodes, stopping at function boundaries (a nested
// function's own await does not make the outer script need hoisting).
function hasTopLevelAwait(program) {
  const isFunctionBoundary = (type) =>
    type === "FunctionDeclaration" ||
    type === "FunctionExpression" ||
    type === "ArrowFunctionExpression";
  function walk(node, insideFunction) {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((n) => walk(n, insideFunction));
    if (typeof node.type !== "string") return false;
    if (!insideFunction) {
      if (node.type === "AwaitExpression") return true;
      if (node.type === "ForOfStatement" && node.await) return true;
    }
    const nextInsideFunction = insideFunction || isFunctionBoundary(node.type);
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range")
        continue;
      const value = node[key];
      if (value && typeof value === "object" && walk(value, nextInsideFunction)) return true;
    }
    return false;
  }
  return walk(program, false);
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
