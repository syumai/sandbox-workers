// Node-only test helpers for `InterpreterServer` -- not for use in a Worker
// (imports `node:sqlite`). Exported from `@sandbox-workers/interpreter/testing`.
//
// `createTestState()` is the same fake `DurableObjectStateLike` this repo's
// own `tests/sandbox-do.test.mjs` builds for `Sandbox`, lifted here so both
// this package's own tests and a third-party engine's tests can drive a real
// `InterpreterServer` from Node without a Workers runtime.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  INTERPRETER_KEY_HEADER,
  Workspace,
  type DurableObjectStateLike,
  type GetWorkspaceFiles,
  type InterpreterExecuteRpcResult,
} from "@sandbox-workers/core";
import { InterpreterServer } from "./server.js";
import type { Engine } from "./engine.js";

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

// ---- runEngineConformance -------------------------------------------------
//
// A conformance suite an `Engine` author -- this repo's four language
// packages and a third party -- runs against their own `Engine`. It drives a
// real `InterpreterServer` (never `InterpreterWorker`/`InterpreterDurableObject`,
// which import `cloudflare:workers` and so cannot run under plain Node) over
// `createTestState()`, and throws (`node:assert/strict`) on the first
// contract violation found. Deliberately not a `node:test` file itself --
// wrap the call in whatever test framework the caller already uses (see
// tests/conformance.test.mjs in this repo for a `node:test` example).

/** A minimal guest program and the text of its expected single result. */
export interface ConformanceProgram {
  code: string;
  /** When given, checked against `outcome.results[0]?.text`. */
  expectResultText?: string;
}

/**
 * Guest programs `runEngineConformance` needs -- the runner has no idea what
 * language `engine` speaks, so the caller supplies minimal snippets in it.
 */
export interface ConformancePrograms {
  /** A trivial program that succeeds with one text result. */
  simple: ConformanceProgram;
  /** A trivial program that produces a guest-level error (e.g. a syntax error). */
  error: { code: string };
  /**
   * Required when `engine.sessions` is set (code contexts): `define` sets
   * some top-level state in a session, `use` reads it back and must produce
   * `expectResultText` -- both run in the same code context, so this is what
   * proves state survives across `execute()` calls, a restart, and a
   * simulated eviction/restore.
   */
  stateful?: { define: string; use: string; expectResultText: string };
}

export interface ConformanceOptions {
  programs: ConformancePrograms;
  /**
   * Backing store for the code-contexts portion of the suite. Defaults to a
   * fresh in-memory `DatabaseSync` (`import { DatabaseSync } from
   * "node:sqlite"` -- this package does not re-export it; it's a Node
   * built-in, not something `@sandbox-workers/interpreter` defines).
   */
  db?: DatabaseSync;
  /** Interpreter key used for every request. Defaults to `"conformance"`. */
  key?: string;
}

function conformanceRequest(method: string, path: string, key: string, body?: unknown): Request {
  const headers = new Headers({ [INTERPRETER_KEY_HEADER]: key });
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`https://interpreter.internal${path}`, init);
}

async function conformanceReadJson(response: Response): Promise<any> {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

/** A fake "sandbox-side" workspace an `InterpreterServer`'s mirror reconciles against. */
function conformanceSandboxSide() {
  const workspace = new Workspace();
  const getFiles: GetWorkspaceFiles = async (paths) =>
    paths
      .filter((path) => {
        try {
          workspace.stat(path, "/workspace");
          return true;
        } catch {
          return false;
        }
      })
      .map((path) => {
        const { data, updatedAt } = workspace.readBytes(path, "/workspace");
        return { path, data, updatedAt };
      });
  const manifestArgs = () => {
    const m = workspace.manifest();
    return { dirs: m.dirs, manifest: m.files };
  };
  return { workspace, getFiles, manifestArgs };
}

/** Narrows an `InterpreterExecuteRpcResult` to its `ok: true` branch, or throws with the failure body. */
function unwrapExecute(
  res: InterpreterExecuteRpcResult,
  label: string,
): Extract<InterpreterExecuteRpcResult, { ok: true }> {
  if (!res.ok) throw new Error(`${label} failed: ${JSON.stringify({ status: res.status, body: res.body })}`);
  return res;
}

/**
 * Drives a real `InterpreterServer` against `engine` and asserts the
 * `Engine`/`SessionInstance` contract (`../engine.ts`'s doc comments) end to
 * end, in this order:
 *
 * 1. Stateless `engine.run()` on `programs.simple` (succeeds, no
 *    `outcome.error`) and `programs.error` (produces `outcome.error`
 *    without throwing).
 * 2. `engine.language`/`engineName`/`build`/`limits` are present and sane.
 * 3. If `engine.sessions` is set (code contexts): create a context, run
 *    `programs.stateful.define` then `.use` and check the result, check
 *    `context.snapshot` is populated, construct a *second*
 *    `InterpreterServer` over the same backing store (simulating this
 *    interpreter's Durable Object being evicted and recreated) and run
 *    `.use` again -- it must still see `.define`'s state, which is the
 *    entire point of memory snapshots -- run `programs.error` in that same
 *    context and check the workspace diff reports no changes (a guest error
 *    rolls the workspace mirror back), delete the context, and check
 *    `DELETE /` wipes it.
 *
 * If `engine.sessions` is absent, only steps 1-2 run (a stateless-only
 * engine, e.g. this repo's Ruby, has nothing else to check).
 */
export async function runEngineConformance(engine: Engine, options: ConformanceOptions): Promise<void> {
  const { programs } = options;
  const key = options.key ?? "conformance";

  // --- 1. stateless engine.run() ------------------------------------------

  const simpleOutcome = await engine.run({ code: programs.simple.code, envVars: {} });
  assert.equal(
    simpleOutcome.error,
    undefined,
    `programs.simple must not produce outcome.error (got ${JSON.stringify(simpleOutcome.error)})`,
  );
  assert.ok(Array.isArray(simpleOutcome.results), "Engine.run()'s outcome.results must be an array");
  if (programs.simple.expectResultText !== undefined) {
    assert.equal(
      simpleOutcome.results[0]?.text,
      programs.simple.expectResultText,
      `programs.simple's result text did not match (got ${JSON.stringify(simpleOutcome.results)})`,
    );
  }

  let errorOutcome;
  try {
    errorOutcome = await engine.run({ code: programs.error.code, envVars: {} });
  } catch (thrown) {
    throw new Error(
      `Engine.run() must not throw for a guest-level error -- return it as outcome.error instead (threw ${thrown instanceof Error ? thrown.message : thrown})`,
    );
  }
  assert.ok(errorOutcome.error, "programs.error must produce outcome.error");

  // --- 2. identity and limits ----------------------------------------------

  assert.ok(engine.language, "Engine.language must be a non-empty string");
  assert.ok(engine.engineName, "Engine.engineName must be a non-empty string");
  assert.ok(engine.build, "Engine.build must be a non-empty string");
  assert.ok(engine.limits, "Engine.limits must be present");
  for (const limit of ["memoryBytes", "codeBytes", "requestBytes"] as const) {
    assert.ok(
      Number.isFinite(engine.limits[limit]) && engine.limits[limit] > 0,
      `Engine.limits.${limit} must be a positive number`,
    );
  }
  assert.ok(
    Number.isFinite(engine.limits.fuel) && engine.limits.fuel >= 0,
    "Engine.limits.fuel must be a non-negative number",
  );

  if (!engine.sessions) return; // stateless-only: nothing further to check.

  assert.ok(programs.stateful, "options.programs.stateful is required for an Engine with sessions");
  const { define, use, expectResultText } = programs.stateful!;

  // --- 3. code contexts ------------------------------------------------------

  const db = options.db ?? new DatabaseSync(":memory:");
  const sandbox = conformanceSandboxSide();

  const server1 = new InterpreterServer(createTestState({ db, id: "conformance" }), {}, () => engine);
  const created = await conformanceReadJson(
    await server1.fetch(conformanceRequest("POST", "/contexts", key, { id: "ctx-1" })),
  );
  assert.equal(created.id, "ctx-1", "POST /contexts must echo the given id");

  const defineRes = unwrapExecute(
    await server1.executeInContext(
      key,
      { contextId: "ctx-1", code: define, envVars: {}, workspace: sandbox.manifestArgs() },
      sandbox.getFiles,
    ),
    "programs.stateful.define",
  );
  assert.equal(
    defineRes.result.error,
    undefined,
    `programs.stateful.define must not produce a guest error (got ${JSON.stringify(defineRes.result.error)})`,
  );

  const useRes = unwrapExecute(
    await server1.executeInContext(
      key,
      { contextId: "ctx-1", code: use, envVars: {}, workspace: sandbox.manifestArgs() },
      sandbox.getFiles,
    ),
    "programs.stateful.use",
  );
  assert.equal(
    useRes.result.results[0]?.text,
    expectResultText,
    `programs.stateful.use did not observe .define's state (got ${JSON.stringify(useRes.result.results)})`,
  );
  assert.ok(useRes.result.context.snapshot, "context.snapshot must be populated after a successful session execute()");
  assert.equal(useRes.result.context.snapshot!.build, engine.build, "context.snapshot.build must match Engine.build");

  // Simulate eviction: a brand-new InterpreterServer over the same backing
  // store, with an empty in-memory workspace mirror (sandbox.getFiles still
  // answers from the sandbox-side workspace, so reconciliation just pulls
  // everything again) -- this is the whole point of memory snapshots.
  const server2 = new InterpreterServer(createTestState({ db, id: "conformance" }), {}, () => engine);
  const afterEviction = unwrapExecute(
    await server2.executeInContext(
      key,
      { contextId: "ctx-1", code: use, envVars: {}, workspace: sandbox.manifestArgs() },
      sandbox.getFiles,
    ),
    "programs.stateful.use (after simulated eviction)",
  );
  assert.equal(
    afterEviction.result.results[0]?.text,
    expectResultText,
    "state did not survive a simulated eviction/restore from the persisted snapshot",
  );

  // A guest error rolls the workspace mirror back: the response reports no
  // file changes at all, even if reconciliation itself pulled files in.
  const errRes = unwrapExecute(
    await server2.executeInContext(
      key,
      { contextId: "ctx-1", code: programs.error.code, envVars: {}, workspace: sandbox.manifestArgs() },
      sandbox.getFiles,
    ),
    "programs.error (in a session)",
  );
  assert.ok(errRes.result.error, "programs.error must still produce outcome.error inside a session");
  assert.deepEqual(errRes.result.workspace.files, [], "a guest error must roll back reported workspace files");
  assert.deepEqual(errRes.result.workspace.deleted, [], "a guest error must roll back reported workspace deletions");

  // Delete context.
  const del = await server2.fetch(conformanceRequest("DELETE", "/contexts/ctx-1", key));
  assert.equal(del.status, 200, "DELETE /contexts/:id on an existing context must succeed");
  const afterDelete = await server2.fetch(conformanceRequest("DELETE", "/contexts/ctx-1", key));
  assert.equal(afterDelete.status, 404, "DELETE /contexts/:id on a missing context must 404");

  // DELETE / wipes everything.
  const created2 = await conformanceReadJson(
    await server2.fetch(conformanceRequest("POST", "/contexts", key, { id: "ctx-2" })),
  );
  assert.equal(created2.id, "ctx-2");
  const wipe = await server2.fetch(conformanceRequest("DELETE", "/", key));
  assert.equal(wipe.status, 200, "DELETE / must succeed");
  const afterWipe = await server2.fetch(conformanceRequest("DELETE", "/contexts/ctx-2", key));
  assert.equal(afterWipe.status, 404, "DELETE / must wipe every context");
}
