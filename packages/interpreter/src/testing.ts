// Node-only test helpers for `InterpreterServer` -- not for use in a Worker
// (imports `node:sqlite`). Exported from `@sandbox-workers/interpreter/testing`.
//
// `createTestState()` is the same fake `DurableObjectStateLike` this repo's
// own `tests/sandbox-do.test.mjs` builds for `Sandbox`, lifted here so both
// this package's own tests and a third-party engine's tests can drive a real
// `InterpreterServer` from Node without a Workers runtime.
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectStateLike } from "@sandbox-workers/core";

// The `node:sqlite` type used below comes from this package's own
// `node-sqlite.d.ts` ambient declaration, not `@types/node` (which this
// package deliberately does not depend on -- its ambient globals collide
// with `@cloudflare/workers-types`'s own; see tsconfig.json's `types`).

/** A `node:sqlite` bound parameter (its `SupportedValueType`). */
type SqliteParam = null | number | bigint | string | Uint8Array;

function isSelect(query: string): boolean {
  return /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
}

/**
 * Builds a fake `DurableObjectStateLike` over a `node:sqlite` `DatabaseSync`
 * (a fresh in-memory one unless `db` is given, so multiple `InterpreterServer`
 * instances can be constructed against "the same DB" -- to test that
 * persisted state survives eviction). `id` is fixed per DB, matching a real
 * Durable Object's stable `ctx.id`.
 */
export function createTestState(options?: { id?: string; db?: DatabaseSync }): DurableObjectStateLike {
  const db = options?.db ?? new DatabaseSync(":memory:");
  const id = options?.id ?? "interpreter-key-1";
  let alarm: number | null = null;
  return {
    id: { toString: () => id },
    storage: {
      sql: {
        exec(query: string, ...params: unknown[]) {
          const stmt = db.prepare(query);
          if (isSelect(query))
            return stmt.all(...(params as SqliteParam[])) as Iterable<Record<string, unknown>>;
          stmt.run(...(params as SqliteParam[]));
          return [];
        },
      },
      transactionSync<T>(fn: () => T): T {
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      async deleteAll() {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>;
        for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(time: number | Date) {
        alarm = time instanceof Date ? time.getTime() : time;
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}
