// A tiny, safe arithmetic expression language for the custom-runtime
// fixture (tests/fixtures/custom-runtime/): integers, `+ - * / ( )`, unary
// `-`, and `env.NAME` lookups against `envVars` -- no `eval()`, no external
// dependencies. Every guest-level problem (a parse error, an unknown
// `env.NAME`, division by zero) is reported through `CalcError`, which
// `runtime.ts` turns into `outcome.error` rather than letting it escape as
// a throw -- see @sandbox-workers/interpreter's README, "The Engine
// contract" ("never throw for an ordinary guest-level error").

export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntaxError";
  }
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "env"; name: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9]/.test(source[j])) j++;
      tokens.push({ kind: "number", value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (source.startsWith("env.", i)) {
      const start = i + 4;
      let j = start;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      if (j === start) throw new CalcError(`Expected a name after 'env.' at position ${i}`);
      tokens.push({ kind: "env", name: source.slice(start, j) });
      i = j;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "(" || ch === ")") {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    throw new CalcError(`Unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

// Recursive-descent parser/evaluator:
//   expr := term (('+' | '-') term)*
//   term := unary (('*' | '/') unary)*
//   unary := '-' unary | atom
//   atom := number | 'env' '.' NAME | '(' expr ')'
function evaluate(tokens: Token[], envVars: Record<string, string>): number {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  function parseAtom(): number {
    const t = peek();
    if (!t) throw new CalcError("Unexpected end of input");
    if (t.kind === "number") {
      pos++;
      return t.value;
    }
    if (t.kind === "env") {
      pos++;
      const raw = envVars[t.name];
      if (raw === undefined) throw new CalcError(`Unknown env var 'env.${t.name}'`);
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new CalcError(`env.${t.name} is not a number: ${JSON.stringify(raw)}`);
      return n;
    }
    if (t.kind === "op" && t.value === "(") {
      pos++;
      const value = parseExpr();
      const close = peek();
      if (!close || close.kind !== "op" || close.value !== ")") throw new CalcError("Expected ')'");
      pos++;
      return value;
    }
    throw new CalcError(`Unexpected token at position ${pos}`);
  }

  function parseUnary(): number {
    const t = peek();
    if (t && t.kind === "op" && t.value === "-") {
      pos++;
      return -parseUnary();
    }
    return parseAtom();
  }

  function parseTerm(): number {
    let value = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.kind === "op" && (t.value === "*" || t.value === "/")) {
        pos++;
        const rhs = parseUnary();
        if (t.value === "*") {
          value *= rhs;
        } else {
          if (rhs === 0) throw new CalcError("Division by zero");
          value /= rhs;
        }
      } else break;
    }
    return value;
  }

  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      const t = peek();
      if (t && t.kind === "op" && (t.value === "+" || t.value === "-")) {
        pos++;
        const rhs = parseTerm();
        value = t.value === "+" ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }

  if (tokens.length === 0) throw new CalcError("Empty program");
  const result = parseExpr();
  if (pos !== tokens.length) throw new CalcError(`Unexpected trailing input at token ${pos}`);
  return result;
}

export function calc(code: string, envVars: Record<string, string>): number {
  return evaluate(tokenize(code), envVars);
}
