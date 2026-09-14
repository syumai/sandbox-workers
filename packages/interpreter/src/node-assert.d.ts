// A minimal, scoped ambient declaration for `node:assert/strict` -- just the
// members `./testing.ts`'s `runEngineConformance` calls. See
// `node-sqlite.d.ts` for why this package declares its own Node ambient
// modules instead of depending on `@types/node`.
declare module "node:assert/strict" {
  interface AssertStrict {
    (value: unknown, message?: string | Error): asserts value;
    ok(value: unknown, message?: string | Error): asserts value;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  }
  const assert: AssertStrict;
  export default assert;
}
