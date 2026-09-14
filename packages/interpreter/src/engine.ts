// The public contract `@sandbox-workers/interpreter` exposes to engine
// authors -- this repo's four language packages and third parties: the
// `Engine` a runtime Worker is built from (see `defineInterpreterRuntime` in
// `index.ts`), and the `SessionInstance` an `Engine.sessions` hands to
// `InterpreterServer` for the code-contexts path. See
// tmp/interpreter-core-split-design.md section 5.1.
//
// Types only, re-exporting core's wire-protocol types where useful. No
// `cloudflare:workers` import here -- safe to import from Node (used by
// engine unit tests).
//
// 0.x note: this interface can still change in a minor release while the
// package is pre-1.0 (see the design doc's risk list, section 9).

import type {
  ExecutionError,
  ExecutionLog,
  ExecutionRequest,
  ExecutionUsage,
  JsonValue,
  Workspace,
} from "@sandbox-workers/core";

/** Resource limits an `Engine` enforces, for both stateless and session execution. */
export interface EngineLimits {
  fuel: number;
  memoryBytes: number;
  codeBytes: number;
  requestBytes: number;
}

/** The result of one execution, on either the stateless or the session path. */
export interface EngineOutcome {
  logs: ExecutionLog;
  results: Array<{ text?: string; json?: JsonValue }>;
  /**
   * A guest-level error (an exception in the guest program) or a resource
   * limit hit (`name: "ExecutionLimitError"`). Never thrown by
   * `SessionInstance.execute` -- see its doc comment below.
   */
  error?: ExecutionError;
  usage?: ExecutionUsage;
}

/**
 * `EngineOutcome` plus the session's cwd after the call. Replaces the
 * pre-split embedded engines' `session: { cwd }` field: `InterpreterServer`
 * reads `cwd` to update the context row. Never sent back to the caller
 * as-is (it is folded into the response's `context.cwd`).
 */
export interface SessionOutcome extends EngineOutcome {
  cwd: string;
}

/** Arguments `Engine.sessions.boot`/`.restore` receive. */
export interface SessionOptions {
  workspace: Workspace;
  cwd: string;
  /**
   * Called synchronously, mid-execution, whenever the guest changes its cwd
   * (e.g. a JS `process.chdir()`) -- not only at the end of `execute()`. A
   * session implementation that only learns the final cwd when `execute()`
   * returns (via `SessionOutcome.cwd`, e.g. an embedded interpreter driven
   * through a single opaque call) may treat this as a no-op.
   */
  onCwdChange(cwd: string): void;
}

/**
 * A previously taken snapshot, as `InterpreterServer` replays it into a
 * freshly instantiated engine. `readPage` is synchronous: `InterpreterServer`
 * reads every stored chunk up front (Durable Object SQLite reads are cheap)
 * before calling `Engine.sessions.restore`.
 */
export interface SessionSnapshotSource {
  /** Engine-defined handle identifying the session's root object inside the restored instance. */
  handle: bigint;
  /** Engine-defined restore state beyond linear memory itself (e.g. the JS engine's interrupt addresses). */
  extra: Record<string, unknown>;
  /** The instance's total Wasm page count; memory is grown to this before pages are replayed. */
  memoryPages: number;
  /** Page `page`'s stored bytes, or undefined for a page that was all-zero when snapshotted. */
  readPage(page: number): Uint8Array | undefined;
}

/**
 * A durable, in-memory engine instance backing one code context, reused
 * across many `execute()` calls and snapshotted to a Durable Object's
 * `chunks` table between them (see `InterpreterServer`, `./snapshot.js`).
 *
 * `execute()` never throws for a guest-level error or a resource limit --
 * both come back as `outcome.error` (`name: "ExecutionLimitError"` for a
 * limit). Throwing out of `execute()` is reserved for host bugs (an
 * unexpected exception in the engine's own glue code); `InterpreterServer`
 * treats any such throw the same as a trap: the resident instance is
 * dropped (no snapshot for that round) and the result becomes a generic
 * `EngineError` (see `envelope.ts`'s `engineErrorOutcome`).
 */
export interface SessionInstance {
  readonly cwd: string;
  /**
   * True once this instance can no longer be used -- a trap, or the fuel
   * hard-backstop invalidated it mid-`execute()`. `InterpreterServer` checks
   * only this flag (never a thrown error) to decide whether to drop the
   * resident instance after a call.
   */
  readonly invalid: boolean;
  execute(payload: { code: string; envVars: Record<string, string> }): SessionOutcome;
  /**
   * False while the guest holds an open file descriptor beyond the
   * preopens, or once the instance is otherwise unsnapshottable (closed,
   * invalid). `InterpreterServer` only calls `snapshot()` when this is true
   * -- see also its own rule that a round whose `outcome.error.name` is
   * `"ExecutionLimitError"` is never snapshotted, regardless of this flag.
   */
  canSnapshot(): boolean;
  snapshot(): { handle: bigint; extra: Record<string, unknown>; memory: WebAssembly.Memory };
  /** Releases whatever this instance holds beyond what `InterpreterServer` itself tracks. */
  close(): void;
}

/**
 * The language-specific contract a runtime Worker is built from (see
 * `defineInterpreterRuntime`). Implemented by each of this repo's four
 * language packages, and by third-party runtimes.
 */
export interface Engine {
  /** e.g. `"python"` -- reported as `ExecutionResult.language` and by `GET /interpreter`. */
  language: string;
  /** e.g. `"CPython 3.14.6 / goccy v0.2.0"` -- reported as `ExecutionResult.engine`. */
  engineName: string;
  /**
   * Identifies this build of the engine (e.g. the Wasm module's sha256). A
   * stored snapshot whose `build` doesn't match this boots fresh instead of
   * restoring, which is what makes an engine upgrade safe against a stale
   * on-disk snapshot.
   */
  build: string;
  limits: EngineLimits;
  /**
   * Stateless execution: `POST /execute`, and the plain `ExecutionRequest`
   * shape. May throw `ExecutionLimitError` -- `InterpreterWorker` turns that
   * into the standard `{ error: { name: "ExecutionLimitError", ... } }`
   * envelope (see `envelope.ts`). Any other throw becomes a generic
   * `EngineError`.
   */
  run(payload: ExecutionRequest): EngineOutcome | Promise<EngineOutcome>;
  /**
   * Code-contexts support. Absent means `contexts: false`: `GET
   * /interpreter` reports it, and every `/interpreters/*` route and
   * `executeInContext` RPC call answers 400 (matching this repo's Ruby
   * engine, which has no durable sessions).
   */
  sessions?: {
    boot(options: SessionOptions): SessionInstance;
    restore(options: SessionOptions, snapshot: SessionSnapshotSource): SessionInstance;
  };
}
