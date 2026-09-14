// Language-neutral half of the "wasmify" embedded-interpreter session host
// (Python and Perl's own Wasm builds, driven through the same protobuf-ish
// ABI as `./protobuf.js`). TypeScript port of the shared parts of
// the pre-split, now-deleted embedded.mjs; everything Python- or Perl-specific goes behind
// the `WasmifyDriver` interface below, implemented by
// `packages/python/src/engine.mjs` and `packages/perl/src/engine.mjs`.
// Exported (together with `./protobuf.js`) from
// `@sandbox-workers/interpreter/wasmify`.
import { createWasi, budget, ExecutionLimitError, hasOpenGuestFds, type WasiHost } from "../wasi.js";
import { memoryPageCount, writePage } from "../snapshot.js";
import { invoke } from "./protobuf.js";
import type {
  EngineLimits,
  EngineOutcome,
  SessionInstance,
  SessionOptions,
  SessionOutcome,
  SessionSnapshotSource,
} from "../engine.js";
import type { Workspace } from "@sandbox-workers/core";

export { ExecutionLimitError };

const encoder = new TextEncoder();

/**
 * The state a `WasmifyDriver` method needs to talk to one embedded
 * interpreter instance: the Wasm instance itself, the interpreter handle
 * `driver.initMethod` produced, and the WASI host (for `host.capture()` and
 * `host.logs`).
 */
export interface WasmifyContext {
  instance: WebAssembly.Instance;
  handle: bigint;
  host: WasiHost;
}

/**
 * The language-specific half of an embedded ("wasmify") interpreter: what
 * `runWasmify`/`bootWasmifySession`/`restoreWasmifySession` need to drive
 * Python's or Perl's own Wasm build. No host wiring (WASI, fuel, snapshot
 * replay) lives here -- that's all in this module, shared.
 */
export interface WasmifyDriver {
  /** wasmify method id that creates the interpreter handle (Python "w_0_5", Perl "w_0_16"); called with [[1, "/stdlib"]]. */
  initMethod: string;
  /** Script evaluated once after init when booting a session (PYTHON_SESSION_BOOT / the Perl session boot sub). */
  sessionBoot: string;
  /**
   * Runs `code` inside the interpreter; captures stdout/stderr into `host`;
   * throws on an interpreter-level failure; returns the driver's string
   * result. Used to run `sessionBoot` (and, e.g., Python's post-restore
   * `afterRestore` hook).
   */
  evaluate(ctx: WasmifyContext, code: string): string;
  /** One session execute: builds the `__sandbox_session_execute(...)` call, runs it, parses the `{ results, error, cwd }` envelope. */
  sessionExecute(
    ctx: WasmifyContext,
    args: { code: string; cwd: string; envVars: Record<string, string> },
  ): { results: EngineOutcome["results"]; error?: EngineOutcome["error"]; cwd?: string };
  /** One stateless run (the old runEmbedded body after init): returns `{ results, error? }`. */
  runOnce(
    ctx: WasmifyContext,
    args: { code: string; envVars: Record<string, string> },
  ): { results: EngineOutcome["results"]; error?: EngineOutcome["error"] };
  /** Optional hook after a restore (Python's random.seed() + path_importer_cache pop). */
  afterRestore?(ctx: WasmifyContext): void;
}

function checkResultLimit(results: unknown): void {
  if (encoder.encode(JSON.stringify(results)).length > 65536)
    throw new ExecutionLimitError("Result limit exceeded");
}

function memoryOf(instance: WebAssembly.Instance): WebAssembly.Memory {
  return (instance.exports as any).memory as WebAssembly.Memory;
}

export function runWasmify(
  module: WebAssembly.Module,
  archive: ArrayBuffer | Uint8Array | null,
  driver: WasmifyDriver,
  payload: { code: string; envVars?: Record<string, string> },
  limits: Pick<EngineLimits, "fuel">,
): EngineOutcome {
  const meter = budget(limits.fuel);
  const host = createWasi(module, archive, meter, payload.envVars ?? {});
  const instance = new WebAssembly.Instance(module, host.imports);
  host.wasi.initialize(instance as any);
  (instance.exports as any).wasm_init();
  const handle = invoke(instance, driver.initMethod, [[1, "/stdlib"]])[1] as bigint;
  if (!handle) throw new Error("Interpreter initialization failed");

  const ctx: WasmifyContext = { instance, handle, host };
  const { results, error } = driver.runOnce(ctx, { code: payload.code, envVars: payload.envVars ?? {} });
  checkResultLimit(results);
  return {
    logs: host.logs,
    results,
    ...(error ? { error } : {}),
    usage: meter.usage(memoryOf(instance)),
  };
}

// The session object returned by both bootWasmifySession and
// restoreWasmifySession, once each has finished setting up its own `ctx`.
// Unlike the JS session, a fuel exhaustion or trap here throws a JS
// exception through the interpreter's own C call stack -- not a clean,
// resumable interrupt -- so `invalid` is set and the caller must boot (or
// restore) a fresh session on the next call.
function buildWasmifySessionApi(
  ctx: WasmifyContext,
  driver: WasmifyDriver,
  meter: ReturnType<typeof budget>,
  fuel: number,
  workspace: Workspace,
  initialCwd: string,
): SessionInstance {
  let cwd = initialCwd;
  let invalid = false;

  return {
    get cwd() {
      return cwd;
    },
    get invalid() {
      return invalid;
    },
    close() {
      invalid = true;
    },
    // Snapshot rules (docs/sessions-design.md): a trap here always sets
    // `invalid` below (in execute()'s catch) before returning, so
    // "!invalid" already means "no trap since the last successful call" --
    // unlike the JS session, execute() here never throws. Also false while
    // the guest holds an open file descriptor beyond the preopens (a real
    // `open()` through WASI, unlike JS's host-function fs facade).
    canSnapshot() {
      return !invalid && !hasOpenGuestFds(ctx.host);
    },
    // { handle, extra, memory }: Python/Perl carry no extra restore state
    // beyond the interpreter handle (no interrupt addresses like JS), so
    // `extra` is empty; kept for shape parity with the JS session's
    // .snapshot() and with restoreWasmifySession's `snapshot` argument.
    snapshot() {
      return { handle: ctx.handle, extra: {}, memory: memoryOf(ctx.instance) };
    },
    execute(payload: { code: string; envVars: Record<string, string> }): SessionOutcome {
      if (invalid) throw new Error("This session instance has been invalidated");
      meter.reset(fuel);
      ctx.host.resetLogs();
      try {
        const { results, error, cwd: reportedCwd } = driver.sessionExecute(ctx, {
          code: payload.code,
          cwd,
          envVars: payload.envVars ?? {},
        });
        // Persist the reported cwd only if it still resolves to a directory
        // under /workspace; otherwise fall back to /workspace, matching the
        // design doc's leniency for an execution that chdir'd outside it.
        // When workspace.disabled is true, workspace.stat() throws EACCES
        // here too, and the catch below's "/workspace" fallback is exactly
        // right (cwd stays reported as /workspace either way).
        try {
          if (reportedCwd) {
            const info = workspace.stat(reportedCwd, "/workspace");
            cwd = info.type === "directory" ? workspace.normalize(reportedCwd, "/workspace").absolute : "/workspace";
          }
        } catch {
          cwd = "/workspace";
        }
        checkResultLimit(results);
        return {
          logs: ctx.host.logs,
          results,
          ...(error ? { error } : {}),
          cwd,
          usage: meter.usage(memoryOf(ctx.instance)),
        };
      } catch (err) {
        invalid = true;
        const limited = err instanceof ExecutionLimitError;
        let usage;
        try {
          usage = meter.usage(memoryOf(ctx.instance));
        } catch {
          usage = { fuelConsumed: fuel, fuelLimit: fuel, memoryBytes: memoryOf(ctx.instance).buffer.byteLength };
        }
        return {
          logs: ctx.host.logs,
          results: [],
          error: {
            name: limited ? "ExecutionLimitError" : "EngineError",
            message: err instanceof Error ? err.message.slice(0, 2048) : "Execution failed",
            traceback: [],
          },
          cwd,
          usage,
        };
      }
    },
  };
}

// A durable session: one embedded interpreter kept alive across many
// execute() calls, and snapshottable to a Durable Object's `chunks` table
// via .snapshot()/.canSnapshot() (see ../snapshot.js and ../server.js).
export function bootWasmifySession(
  module: WebAssembly.Module,
  archive: ArrayBuffer | Uint8Array | null,
  driver: WasmifyDriver,
  options: SessionOptions,
  limits: Pick<EngineLimits, "fuel">,
): SessionInstance {
  const { workspace, cwd } = options;
  const meter = budget(limits.fuel);
  const host = createWasi(module, archive, meter, {}, workspace.root, {
    workspaceDisabled: () => workspace.disabled === true,
  });
  const instance = new WebAssembly.Instance(module, host.imports);
  host.wasi.initialize(instance as any);
  (instance.exports as any).wasm_init();
  const handle = invoke(instance, driver.initMethod, [[1, "/stdlib"]])[1] as bigint;
  if (!handle) throw new Error("Interpreter initialization failed");

  const ctx: WasmifyContext = { instance, handle, host };
  driver.evaluate(ctx, driver.sessionBoot);

  return buildWasmifySessionApi(ctx, driver, meter, limits.fuel, workspace, cwd);
}

// Restores a session from a previous .snapshot() (see ../server.js):
// instantiates fresh, then -- per docs/sessions-design.md's verified restore
// recipe -- points wasi.inst at the instance directly (no wasi.initialize(),
// no _initialize, no wasm_init()), grows memory to the snapshot's page count,
// and copies its non-zero pages back in. The interpreter handle from the
// snapshot is reused as-is (no re-init call).
export function restoreWasmifySession(
  module: WebAssembly.Module,
  archive: ArrayBuffer | Uint8Array | null,
  driver: WasmifyDriver,
  options: SessionOptions,
  snapshot: SessionSnapshotSource,
  limits: Pick<EngineLimits, "fuel">,
): SessionInstance {
  const { workspace, cwd } = options;
  const meter = budget(limits.fuel);
  const host = createWasi(module, archive, meter, {}, workspace.root, {
    workspaceDisabled: () => workspace.disabled === true,
  });
  const instance = new WebAssembly.Instance(module, host.imports);
  (host.wasi as any).inst = instance;

  const { handle, memoryPages, readPage: readSnapshotPage } = snapshot;
  const memory = memoryOf(instance);
  const currentPages = memoryPageCount(memory);
  if (memoryPages > currentPages) memory.grow(memoryPages - currentPages);
  for (let page = 0; page < memoryPages; page++) {
    const data = readSnapshotPage(page);
    if (data) writePage(memory, page, data);
  }

  const ctx: WasmifyContext = { instance, handle, host };
  driver.afterRestore?.(ctx);

  return buildWasmifySessionApi(ctx, driver, meter, limits.fuel, workspace, cwd);
}
