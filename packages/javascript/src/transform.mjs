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
//
// TypeScript support mirrors transformForAsyncExecution above: JavaScript is
// always tried first with acorn, and only code acorn rejects is handed to
// sucrase to strip TypeScript-only syntax before it is re-parsed. A
// top-level `return` never reaches the sucrase fallback for a reason that
// still holds after stripping: a "script" never allows `return` outside a
// function, so any source containing one — TypeScript or not — always fails
// tryParseJavaScript and falls through to the `raw` mode below, which
// evaluates the (possibly stripped) source directly and unwrapped, so
// js_eval reports a genuine SyntaxError instead of the `return` silently
// exiting the `hoist` mode's async IIFE.
export function transformForRepl(code) {
  if (!code || !code.trim()) return { mode: "raw", code: "" };
  let program = tryParseJavaScript(code);
  let source = code;
  if (!program) {
    let stripped;
    try {
      stripped = sucraseTransform(code, {
        transforms: ["typescript"],
        disableESTransforms: true,
      }).code;
    } catch {
      // Not valid TypeScript either. Let SpiderMonkey report the real
      // SyntaxError directly against the guest's own original code.
      return { mode: "raw", code };
    }
    program = tryParseJavaScript(stripped);
    if (!program) return { mode: "raw", code: stripped };
    source = stripped;
  }
  const needsHoist = hasTopLevelAwait(program);
  if (!needsHoist) {
    const body = program.body;
    const last = body.at(-1);
    if (last && last.type === "ExpressionStatement") {
      const before = source.slice(0, last.start);
      const exprText = source.slice(last.start, last.end).replace(/;\s*$/, "");
      return { mode: "capture", code: `${before}globalThis.__sandboxSession.setResult(${exprText});` };
    }
    // No top-level `return` special-casing is needed here: a genuine
    // top-level `return` stays a real SyntaxError straight from js_eval,
    // because this path never wraps the code in a function.
    return { mode: "raw", code: source };
  }
  const hoisted = [];
  let bodyText = "";
  let cursor = 0;
  const body = program.body;
  body.forEach((node, i) => {
    bodyText += source.slice(cursor, node.start);
    cursor = node.end;
    if (node.type === "VariableDeclaration") {
      bodyText += rewriteVariableDeclaration(source, node, hoisted);
    } else if (
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") &&
      node.id
    ) {
      hoisted.push(node.id.name);
      bodyText += `${toAssignment(source, node)};`;
    } else if (i === body.length - 1 && node.type === "ExpressionStatement") {
      const exprText = source.slice(node.start, node.end).replace(/;\s*$/, "");
      bodyText += `globalThis.__sandboxSession.setResult(${exprText});`;
    } else {
      bodyText += source.slice(node.start, node.end);
    }
  });
  bodyText += source.slice(cursor);
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
