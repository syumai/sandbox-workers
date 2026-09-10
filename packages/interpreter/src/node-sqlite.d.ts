// A minimal, scoped ambient declaration for `node:sqlite` -- just the
// members `./testing.ts`'s `createTestState` calls. This package has no
// `@types/node` dependency: `@types/node`'s ambient globals (Buffer, fetch,
// URL, ReadableStream, ...) collide with `@cloudflare/workers-types`'s own
// (see tsconfig.json's `types`, which deliberately omits both DOM and Node
// lib globals, matching core's reasoning for staying off `lib: DOM`). This
// file has no top-level import/export, which is what makes `declare module`
// below a fresh ambient module declaration rather than an augmentation of
// an existing one (TypeScript would otherwise require `node:sqlite` to
// already be resolvable elsewhere).
declare module "node:sqlite" {
  type SqliteParam = null | number | bigint | string | Uint8Array;
  export class DatabaseSync {
    constructor(location: string);
    prepare(sql: string): {
      all(...params: SqliteParam[]): Array<Record<string, unknown>>;
      run(...params: SqliteParam[]): unknown;
    };
    exec(sql: string): void;
  }
}
