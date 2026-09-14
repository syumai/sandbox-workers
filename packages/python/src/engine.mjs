// The Python-specific half of the wasmify embedded interpreter: driver
// scripts, envelope parsing, and the `WasmifyDriver` object
// `@sandbox-workers/interpreter/wasmify`'s runWasmify/bootWasmifySession/
// restoreWasmifySession drive. Ported from the Python branches of
// the pre-split, now-deleted embedded.mjs.
import { invoke } from "@sandbox-workers/interpreter/wasmify";

const encoder = new TextEncoder();
const decode = (bytes) => new TextDecoder().decode(bytes);
const hex = (value) =>
  Array.from(encoder.encode(JSON.stringify(value ?? null)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

// Note: importing the stdlib "traceback" module costs tens of millions of
// fuel ticks in this embedded interpreter (it drags in linecache/re), enough
// to exhaust the budget on its own. Traceback lines are built by hand from
// the exception's own __traceback__ frames instead.
// The embedded interpreter decodes WASI environ entries as ASCII with
// surrogateescape (matching CPython's POSIX default for a non-UTF-8 locale),
// so a non-ASCII envVars value round-trips as lone surrogates instead of
// text. Re-decode once as UTF-8 so os.environ reads back cleanly.
const PYTHON_DRIVER = `import ast as __sandbox_ast, json as __sandbox_json, os as __sandbox_os
__sandbox_os.environ = {k: v.encode("utf-8", "surrogateescape").decode("utf-8", "replace") for k, v in __sandbox_os.environ.items()}
def __sandbox_run(src):
    tree = __sandbox_ast.parse(src, "<sandbox>", "exec")
    scope = {"__name__": "__main__", "__builtins__": __builtins__}
    last = None
    if tree.body and isinstance(tree.body[-1], __sandbox_ast.Expr):
        last = __sandbox_ast.Expression(tree.body.pop().value)
    exec(compile(tree, "<sandbox>", "exec"), scope)
    if last is not None:
        return eval(compile(last, "<sandbox>", "eval"), scope)
    return None
try:
    __sandbox_value = __sandbox_run(__sandbox_json.loads(bytes.fromhex('%SOURCE%')))
    if __sandbox_value is None:
        __sandbox_results = []
    elif isinstance(__sandbox_value, (dict, list)):
        try:
            __sandbox_json.dumps(__sandbox_value, allow_nan=False)
            __sandbox_results = [{"json": __sandbox_value}]
        except Exception:
            __sandbox_results = [{"text": repr(__sandbox_value)}]
    else:
        __sandbox_results = [{"text": repr(__sandbox_value)}]
    __sandbox_envelope = {"results": __sandbox_results, "error": None}
except BaseException as __sandbox_error:
    __sandbox_tb = [type(__sandbox_error).__name__ + ": " + str(__sandbox_error)]
    __sandbox_frame = __sandbox_error.__traceback__
    while __sandbox_frame is not None:
        __sandbox_code = __sandbox_frame.tb_frame.f_code
        __sandbox_tb.append("  File \\"" + __sandbox_code.co_filename + "\\", line " + str(__sandbox_frame.tb_lineno) + ", in " + __sandbox_code.co_name)
        __sandbox_frame = __sandbox_frame.tb_next
    __sandbox_envelope = {"results": [], "error": {"name": type(__sandbox_error).__name__, "message": str(__sandbox_error), "traceback": __sandbox_tb}}
__sandbox_result = __sandbox_json.dumps(__sandbox_envelope, allow_nan=False)`;

// Session variant of the driver above: defined once at boot (so its
// definitions persist, like every other top-level name in this embedded
// interpreter), and invoked per execution with the (hex-encoded, to dodge
// any quoting issue with arbitrary user source) code/cwd/envVars. Unlike the
// stateless PYTHON_DRIVER (which execs user code into a throwaway `scope`
// dict so a disposable instance behaves identically to running it directly),
// the session driver execs directly against the module's own persistent
// __main__ globals, so top-level def/class/assignment naturally survive to
// the next evaluate() call on the same handle — exactly the way separate
// evaluate() calls already see each other's top-level names today.
const PYTHON_SESSION_BOOT = `import ast as __sandbox_ast, json as __sandbox_json, os as __sandbox_os, sys as __sandbox_sys
if "/workspace" not in __sandbox_sys.path:
    __sandbox_sys.path.insert(0, "/workspace")
def __sandbox_run(src):
    tree = __sandbox_ast.parse(src, "<sandbox>", "exec")
    last = None
    if tree.body and isinstance(tree.body[-1], __sandbox_ast.Expr):
        last = __sandbox_ast.Expression(tree.body.pop().value)
    exec(compile(tree, "<sandbox>", "exec"), globals())
    if last is not None:
        return eval(compile(last, "<sandbox>", "eval"), globals())
    return None
def __sandbox_session_execute(src_hex, cwd_hex, env_hex):
    __sandbox_cwd = __sandbox_json.loads(bytes.fromhex(cwd_hex))
    __sandbox_envvars = __sandbox_json.loads(bytes.fromhex(env_hex))
    __sandbox_os.environ.clear()
    __sandbox_os.environ.update(__sandbox_envvars)
    try:
        __sandbox_os.chdir(__sandbox_cwd)
    except Exception:
        pass
    try:
        __sandbox_value = __sandbox_run(__sandbox_json.loads(bytes.fromhex(src_hex)))
        if __sandbox_value is None:
            __sandbox_results = []
        elif isinstance(__sandbox_value, (dict, list)):
            try:
                __sandbox_json.dumps(__sandbox_value, allow_nan=False)
                __sandbox_results = [{"json": __sandbox_value}]
            except Exception:
                __sandbox_results = [{"text": repr(__sandbox_value)}]
        else:
            __sandbox_results = [{"text": repr(__sandbox_value)}]
        __sandbox_envelope = {"results": __sandbox_results, "error": None}
    except BaseException as __sandbox_error:
        __sandbox_tb = [type(__sandbox_error).__name__ + ": " + str(__sandbox_error)]
        __sandbox_frame = __sandbox_error.__traceback__
        while __sandbox_frame is not None:
            __sandbox_code = __sandbox_frame.tb_frame.f_code
            __sandbox_tb.append("  File \\"" + __sandbox_code.co_filename + "\\", line " + str(__sandbox_frame.tb_lineno) + ", in " + __sandbox_code.co_name)
            __sandbox_frame = __sandbox_frame.tb_next
        __sandbox_envelope = {"results": [], "error": {"name": type(__sandbox_error).__name__, "message": str(__sandbox_error), "traceback": __sandbox_tb}}
    __sandbox_envelope["cwd"] = __sandbox_os.getcwd()
    return __sandbox_json.dumps(__sandbox_envelope, allow_nan=False)
"booted"`;

// Raw `w_0_2` (Python eval) call: captures stdout/stderr into `host`, throws
// on an interpreter-level failure, and returns the driver's `repr` string
// result. Also used directly (not just as `driver.evaluate`) by
// restorePythonSession's post-restore `random.seed()` call, before any
// session-level state exists.
function evaluatePythonRaw(instance, handle, host, code) {
  const out = JSON.parse(
    decode(
      invoke(instance, "w_0_2", [
        [1, handle],
        [2, code],
      ])[1],
    ),
  );
  if (out.stdout) host.capture("log", out.stdout);
  if (out.stderr) host.capture("error", out.stderr);
  if (!out.ok) throw new Error(out.error || "Python execution failed");
  return out.repr;
}

function parseHexEnvelope(encoded) {
  if (!/^'[0-9a-f]*'$/.test(encoded)) throw new Error("Invalid Python result");
  return JSON.parse(
    decode(Uint8Array.from(encoded.slice(1, -1).match(/../g) ?? [], (b) => parseInt(b, 16))),
  );
}

/** The Python `WasmifyDriver` (see `@sandbox-workers/interpreter/wasmify`). */
export const pythonDriver = {
  initMethod: "w_0_5",
  sessionBoot: PYTHON_SESSION_BOOT,
  evaluate(ctx, code) {
    return evaluatePythonRaw(ctx.instance, ctx.handle, ctx.host, code);
  },
  sessionExecute(ctx, { code, cwd, envVars }) {
    evaluatePythonRaw(
      ctx.instance,
      ctx.handle,
      ctx.host,
      `__sandbox_result = __sandbox_session_execute('${hex(code)}', '${hex(cwd)}', '${hex(envVars ?? {})}')`,
    );
    const encoded = evaluatePythonRaw(ctx.instance, ctx.handle, ctx.host, "__sandbox_result.encode('utf-8').hex()");
    const envelope = parseHexEnvelope(encoded);
    return { results: envelope.results, error: envelope.error ?? undefined, cwd: envelope.cwd };
  },
  // envVars is not read here: it's already visible to the guest as
  // os.environ, set up by createWasi() from payload.envVars before this
  // driver ever runs (see runWasmify in @sandbox-workers/interpreter/wasmify).
  runOnce(ctx, { code }) {
    evaluatePythonRaw(ctx.instance, ctx.handle, ctx.host, PYTHON_DRIVER.replace("%SOURCE%", hex(code)));
    const encoded = evaluatePythonRaw(ctx.instance, ctx.handle, ctx.host, "__sandbox_result.encode('utf-8').hex()");
    const envelope = parseHexEnvelope(encoded);
    return { results: envelope.results, error: envelope.error ?? undefined };
  },
  // Python's `random` module seeds itself from OS entropy read once, at
  // interpreter startup; a restored instance's module-level state (including
  // that seed) is exactly whatever it was when the snapshot was taken, so
  // without this every restored session would replay the same "random"
  // sequence from that point on. Re-seed once, before the caller's first
  // post-restore execute() (JavaScript's Math.random has no such hook --
  // see the sessions guide for that caveat).
  //
  // `import random` itself walks the whole of sys.path (PathFinder checks
  // every entry, including /workspace, for every import that isn't resolved
  // by an earlier meta path finder) and caches /workspace's directory
  // listing in a FileFinder. @bjorn3/browser_wasi_shim's Directory.stat()
  // always reports mtime 0, so that cache would otherwise never invalidate
  // -- any file written to /workspace after this reseed (by a later
  // execute(), or already sitting in a freshly-provided workspace's rows)
  // could become permanently invisible to `import` even though `open()`/
  // `os.listdir()` see it fine. Drop just that one cache entry via `sys`
  // (already imported, so this costs nothing beyond a dict pop) rather than
  // `importlib.invalidate_caches()`, which needs a first-time `import
  // importlib` and was measured to blow the fuel budget on this heavily
  // tick-instrumented engine (see the note on the `traceback` module above).
  afterRestore(ctx) {
    evaluatePythonRaw(
      ctx.instance,
      ctx.handle,
      ctx.host,
      "import random; random.seed()\nimport sys; sys.path_importer_cache.pop('/workspace', None)",
    );
  },
};
