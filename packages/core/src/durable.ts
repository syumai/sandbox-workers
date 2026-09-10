// Structural host types for Durable Object storage, shared by `sandbox.ts`
// (the caller-hosted `Sandbox` Durable Object) and, per
// tmp/interpreter-core-split-design.md section 5.2, the future
// `@sandbox-workers/interpreter` package's `InterpreterServer`. Declared here
// (rather than imported from `@cloudflare/workers-types`) so this package has
// no build-time dependency on Workers types. A real
// `DurableObjectState`/its `env` satisfy these structurally.

export interface SqlStorageLike {
  exec(query: string, ...params: unknown[]): Iterable<Record<string, unknown>>;
}
export interface DurableObjectStorageLike {
  sql: SqlStorageLike;
  transactionSync<T>(closure: () => T): T;
  deleteAll(): unknown;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface DurableObjectStateLike {
  id: { toString(): string };
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
