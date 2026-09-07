import { createWasi, budget, ExecutionLimitError, hasOpenGuestFds } from "./wasi.mjs";
import { memoryPageCount, writePage } from "./snapshot.mjs";
import { invoke } from "./protobuf.mjs";
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
// Session variants of the two drivers above: defined once at boot (so their
// definitions persist, like every other top-level name in these embedded
// interpreters — see the comment on PYTHON_DRIVER/the Perl driver text), and
// invoked per execution with the (hex-encoded, to dodge any quoting issue
// with arbitrary user source) code/cwd/envVars. Unlike the stateless
// PYTHON_DRIVER (which execs user code into a throwaway `scope` dict so a
// disposable instance behaves identically to running it directly), the
// session driver execs directly against the module's own persistent
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

const PERL_SESSION_BOOT = `use utf8;
binmode(STDOUT, ':encoding(UTF-8)');
binmode(STDERR, ':encoding(UTF-8)');
use JSON::PP;
use Cwd qw(getcwd);
sub __sandbox_session_execute {
    my ($__sandbox_src_hex, $__sandbox_cwd_hex, $__sandbox_env_hex) = @_;
    my $__sandbox_src = pack("H*", $__sandbox_src_hex);
    utf8::decode($__sandbox_src);
    my $__sandbox_cwd = pack("H*", $__sandbox_cwd_hex);
    utf8::decode($__sandbox_cwd);
    my $__sandbox_env_json = pack("H*", $__sandbox_env_hex);
    utf8::decode($__sandbox_env_json);
    my $__sandbox_env_ref = JSON::PP->new->decode($__sandbox_env_json);
    my %__sandbox_env_utf8;
    for my $__sandbox_key (keys %$__sandbox_env_ref) {
        my $__sandbox_val = $__sandbox_env_ref->{$__sandbox_key};
        utf8::decode($__sandbox_val) unless utf8::is_utf8($__sandbox_val);
        $__sandbox_env_utf8{$__sandbox_key} = $__sandbox_val;
    }
    *ENV = \\%__sandbox_env_utf8;
    eval { chdir($__sandbox_cwd) };
    my $__sandbox_value = eval $__sandbox_src;
    my $__sandbox_err = $@;
    my $__sandbox_envelope;
    if ($__sandbox_err) {
        my $__sandbox_name = ref($__sandbox_err) ? ref($__sandbox_err) : "PerlError";
        my $__sandbox_message = "$__sandbox_err";
        $__sandbox_message =~ s/\\n+$//;
        $__sandbox_envelope = { results => [], error => { name => $__sandbox_name, message => $__sandbox_message, traceback => [] } };
    } else {
        my $__sandbox_ref2 = ref($__sandbox_value);
        my @__sandbox_results;
        if (!defined $__sandbox_value) {
            @__sandbox_results = ();
        } elsif ($__sandbox_ref2 eq 'HASH' || $__sandbox_ref2 eq 'ARRAY') {
            my $__sandbox_ok = eval { JSON::PP->new->allow_nonref->utf8->encode($__sandbox_value); 1 };
            if ($__sandbox_ok) { @__sandbox_results = ({ json => $__sandbox_value }); }
            else { @__sandbox_results = ({ text => "$__sandbox_value" }); }
        } else {
            @__sandbox_results = ({ text => "$__sandbox_value" });
        }
        $__sandbox_envelope = { results => \\@__sandbox_results, error => undef };
    }
    $__sandbox_envelope->{cwd} = getcwd();
    return JSON::PP->new->allow_nonref->utf8->encode($__sandbox_envelope);
}
"booted"`;

// Raw response decode for the Perl embedding's invoke (w_0_8): a status
// byte, then either an error string, or a value-encoding tag (4 == string,
// the only shape either driver above ever returns) followed by the string
// itself, then the stdout/stderr captured during the call.
function invokePerlRaw(instance, handle, code) {
  const bytes = invoke(instance, "w_0_8", [
    [1, handle],
    [2, code],
  ])[1];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const byte = () => view.getUint8(offset++);
  const string = () => {
    const n = view.getUint32(offset, true);
    offset += 4;
    const s = decode(bytes.subarray(offset, offset + n));
    offset += n;
    return s;
  };
  const status = byte();
  let result;
  if (status === 1) {
    result = { ok: false, error: string().replace(/\n+$/, "") };
  } else if (status === 0) {
    const tag = byte();
    if (tag !== 4) throw new Error("Invalid Perl result");
    byte();
    result = { ok: true, value: string() };
  } else throw new Error("Perl exited without returning a result");
  const stdout = string(),
    stderr = string();
  return { ...result, stdout, stderr };
}

// Raw `w_0_2` (Python eval) call, factored out of buildEmbeddedApi below so
// restoreEmbeddedSession can also use it for the post-restore `random.seed()`
// call before any session-level state (like buildEmbeddedApi's `cwd`) exists.
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

// The session object returned by both createEmbeddedSession and
// restoreEmbeddedSession, once each has finished setting up its own
// `instance`/`handle`. Unlike the JS session, a fuel exhaustion or trap here
// throws a JS exception through the interpreter's own C call stack — not a
// clean, resumable interrupt — so `invalid` is set and the caller must boot
// (or restore) a fresh session on the next call.
function buildEmbeddedApi({ instance, handle, host, meter, fuel, workspace, language, cwd: initialCwd }) {
  let cwd = initialCwd;
  let invalid = false;

  const evaluatePython = (code) => evaluatePythonRaw(instance, handle, host, code);

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
    // "!invalid" already means "no trap since the last successful call" —
    // unlike the JS session, execute() here never throws. Also false while
    // the guest holds an open file descriptor beyond the preopens (a real
    // `open()` through WASI, unlike JS's host-function fs facade).
    canSnapshot() {
      return !invalid && !hasOpenGuestFds(host);
    },
    // { handle, extra, memory }: Python/Perl carry no extra restore state
    // beyond the interpreter handle (no interrupt addresses like JS), so
    // `extra` is empty; kept for shape parity with the JS session's
    // .snapshot() and with restoreEmbeddedSession's `options.snapshot`.
    snapshot() {
      return { handle, extra: {}, memory: instance.exports.memory };
    },
    execute(payload) {
      if (invalid) throw new Error("This session instance has been invalidated");
      meter.reset(fuel);
      host.resetLogs();
      const requestedCwd = payload.cwd ?? cwd;
      try {
        let results, error, reportedCwd;
        if (language === "python") {
          evaluatePython(
            `__sandbox_result = __sandbox_session_execute('${hex(payload.code)}', '${hex(requestedCwd)}', '${hex(payload.envVars ?? {})}')`,
          );
          const encoded = evaluatePython("__sandbox_result.encode('utf-8').hex()");
          if (!/^'[0-9a-f]*'$/.test(encoded)) throw new Error("Invalid Python result");
          const envelope = JSON.parse(
            decode(
              Uint8Array.from(encoded.slice(1, -1).match(/../g) ?? [], (b) => parseInt(b, 16)),
            ),
          );
          results = envelope.results;
          error = envelope.error ?? undefined;
          reportedCwd = envelope.cwd;
        } else {
          const hexEncode = (str) =>
            Array.from(encoder.encode(str), (b) => b.toString(16).padStart(2, "0")).join("");
          const call = `__sandbox_session_execute('${hexEncode(payload.code)}', '${hexEncode(requestedCwd)}', '${hexEncode(JSON.stringify(payload.envVars ?? {}))}')`;
          const out = invokePerlRaw(instance, handle, call);
          if (out.stdout) host.capture("log", out.stdout);
          if (out.stderr) host.capture("error", out.stderr);
          if (!out.ok) throw new Error(out.error || "Perl execution failed");
          const envelope = JSON.parse(out.value);
          results = envelope.results;
          error = envelope.error ?? undefined;
          reportedCwd = envelope.cwd;
        }
        // Persist the reported cwd only if it still resolves to a directory
        // under /workspace; otherwise fall back to /workspace, matching the
        // design doc's leniency for an execution that chdir'd outside it.
        // When workspace.disabled is true, workspace.stat() throws EACCES
        // here too, and the catch below's "/workspace" fallback is exactly
        // right (cwd stays reported as /workspace either way).
        try {
          if (workspace && reportedCwd) {
            const info = workspace.stat(reportedCwd, "/workspace");
            cwd =
              info.type === "directory" ? workspace.normalize(reportedCwd, "/workspace").absolute : "/workspace";
          } else if (reportedCwd) {
            cwd = reportedCwd;
          }
        } catch {
          cwd = "/workspace";
        }
        if (encoder.encode(JSON.stringify(results)).length > 65536)
          throw new ExecutionLimitError("Result limit exceeded");
        return {
          logs: host.logs,
          results,
          ...(error ? { error } : {}),
          session: { cwd },
          usage: meter.usage(instance.exports.memory),
        };
      } catch (err) {
        invalid = true;
        const limited = err instanceof ExecutionLimitError;
        let usage;
        try {
          usage = meter.usage(instance.exports.memory);
        } catch {
          usage = { fuelConsumed: fuel, fuelLimit: fuel, memoryBytes: instance.exports.memory.buffer.byteLength };
        }
        return {
          logs: host.logs,
          results: [],
          error: {
            name: limited ? "ExecutionLimitError" : "EngineError",
            message: err instanceof Error ? err.message.slice(0, 2048) : "Execution failed",
            traceback: [],
          },
          session: { cwd },
          usage,
        };
      }
    },
  };
}

// A durable session: one embedded interpreter kept alive across many
// execute() calls, and snapshottable to a Durable Object's `pages` table via
// .snapshot()/.canSnapshot() (see runtime/snapshot.mjs and runtime/sandbox.mjs).
export function createEmbeddedSession(module, archive, language, options = {}) {
  const workspace = options.workspace ?? null;
  const cwd = options.cwd ?? "/workspace";
  const fuel = language === "perl" ? 10_000_000 : 100_000_000;
  const meter = budget(fuel);
  const host = createWasi(module, archive, meter, {}, workspace?.root ?? null, {
    workspaceDisabled: () => workspace?.disabled === true,
  });
  const instance = new WebAssembly.Instance(module, host.imports);
  host.wasi.initialize(instance);
  instance.exports.wasm_init();
  const handle = invoke(instance, language === "python" ? "w_0_5" : "w_0_16", [[1, "/stdlib"]])[1];
  if (!handle) throw new Error("Interpreter initialization failed");

  if (language === "python") {
    evaluatePythonRaw(instance, handle, host, PYTHON_SESSION_BOOT);
  } else {
    const boot = invokePerlRaw(instance, handle, PERL_SESSION_BOOT);
    if (boot.stdout) host.capture("log", boot.stdout);
    if (boot.stderr) host.capture("error", boot.stderr);
    if (!boot.ok) throw new Error(boot.error || "Perl session initialization failed");
  }

  return buildEmbeddedApi({ instance, handle, host, meter, fuel, workspace, language, cwd });
}

// Restores a session from a previous .snapshot() (see runtime/sandbox.mjs):
// instantiates fresh, then -- per docs/sessions-design.md's verified restore
// recipe -- points wasi.inst at the instance directly (no wasi.initialize(),
// no _initialize, no wasm_init()), grows memory to the snapshot's page count,
// and copies its non-zero pages back in. The interpreter handle from the
// snapshot is reused as-is (no re-init call).
//
// `options.snapshot` is `{ handle, memoryPages, readPage }` (`extra` is
// accepted but unused -- Python/Perl need no extra restore state); `readPage`
// mirrors restoreJavaScriptSession's contract, see there.
export function restoreEmbeddedSession(module, archive, language, options = {}) {
  const workspace = options.workspace ?? null;
  const cwd = options.cwd ?? "/workspace";
  const fuel = language === "perl" ? 10_000_000 : 100_000_000;
  const meter = budget(fuel);
  const host = createWasi(module, archive, meter, {}, workspace?.root ?? null, {
    workspaceDisabled: () => workspace?.disabled === true,
  });
  const instance = new WebAssembly.Instance(module, host.imports);
  host.wasi.inst = instance;

  const { handle, memoryPages, readPage: readSnapshotPage } = options.snapshot;
  const currentPages = memoryPageCount(instance.exports.memory);
  if (memoryPages > currentPages) instance.exports.memory.grow(memoryPages - currentPages);
  for (let page = 0; page < memoryPages; page++) {
    const data = readSnapshotPage(page);
    if (data) writePage(instance.exports.memory, page, data);
  }

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
  // tick-instrumented engine (see the note on the `traceback` module below).
  if (language === "python")
    evaluatePythonRaw(
      instance,
      handle,
      host,
      "import random; random.seed()\nimport sys; sys.path_importer_cache.pop('/workspace', None)",
    );

  return buildEmbeddedApi({ instance, handle, host, meter, fuel, workspace, language, cwd });
}

export function runEmbedded(module, archive, language, payload) {
  const meter = budget(language === "perl" ? 10_000_000 : 100_000_000),
    host = createWasi(module, archive, meter, payload.envVars ?? {});
  const instance = new WebAssembly.Instance(module, host.imports);
  host.wasi.initialize(instance);
  instance.exports.wasm_init();
  const handle = invoke(instance, language === "python" ? "w_0_5" : "w_0_16", [
    [1, "/stdlib"],
  ])[1];
  if (!handle) throw new Error("Interpreter initialization failed");
  let results, error;
  if (language === "python") {
    const evaluate = (code) => {
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
    };
    evaluate(PYTHON_DRIVER.replace("%SOURCE%", hex(payload.code)));
    const encoded = evaluate("__sandbox_result.encode('utf-8').hex()");
    if (!/^'[0-9a-f]*'$/.test(encoded))
      throw new Error("Invalid Python result");
    const envelope = JSON.parse(
      decode(
        Uint8Array.from(encoded.slice(1, -1).match(/../g) ?? [], (b) =>
          parseInt(b, 16),
        ),
      ),
    );
    results = envelope.results;
    error = envelope.error ?? undefined;
  } else {
    // %ENV entries come back as raw bytes; utf8::decode-ing them in place
    // trips Perl's "Wide character in setenv" warning on the next write-back
    // magic, so build a plain (non-magical) hash and alias *ENV to it.
    // Decoded %ENV values and "use utf8" literals are Perl character strings
    // (not bytes); without an encoding layer on STDOUT/STDERR, printing them
    // warns ("Wide character in print") and can write the wrong bytes. Set
    // the layer once so every print of a character string is UTF-8 encoded
    // exactly once, consistently with JSON::PP's own ->utf8 encode below.
    const code = `use utf8;
binmode(STDOUT, ':encoding(UTF-8)');
binmode(STDERR, ':encoding(UTF-8)');
my %__sandbox_env = %ENV;
for my $__sandbox_key (keys %__sandbox_env) { utf8::decode($__sandbox_env{$__sandbox_key}); }
*ENV = \\%__sandbox_env;
use JSON::PP;
my $__sandbox_value = eval { do {
${payload.code}
} };
my $__sandbox_err = $@;
my $__sandbox_envelope;
if ($__sandbox_err) {
  my $__sandbox_name = ref($__sandbox_err) ? ref($__sandbox_err) : "PerlError";
  my $__sandbox_message = "$__sandbox_err";
  $__sandbox_message =~ s/\\n+$//;
  $__sandbox_envelope = { results => [], error => { name => $__sandbox_name, message => $__sandbox_message, traceback => [] } };
} else {
  my $__sandbox_ref = ref($__sandbox_value);
  my @__sandbox_results;
  if (!defined $__sandbox_value) {
    @__sandbox_results = ();
  } elsif ($__sandbox_ref eq 'HASH' || $__sandbox_ref eq 'ARRAY') {
    my $__sandbox_ok = eval { JSON::PP->new->allow_nonref->utf8->encode($__sandbox_value); 1 };
    if ($__sandbox_ok) {
      @__sandbox_results = ({ json => $__sandbox_value });
    } else {
      @__sandbox_results = ({ text => "$__sandbox_value" });
    }
  } else {
    @__sandbox_results = ({ text => "$__sandbox_value" });
  }
  $__sandbox_envelope = { results => \\@__sandbox_results, error => undef };
}
JSON::PP->new->allow_nonref->utf8->encode($__sandbox_envelope);`;
    const bytes = invoke(instance, "w_0_8", [
      [1, handle],
      [2, code],
    ])[1];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const byte = () => view.getUint8(offset++);
    const string = () => {
      const n = view.getUint32(offset, true);
      offset += 4;
      const s = decode(bytes.subarray(offset, offset + n));
      offset += n;
      return s;
    };
    const status = byte();
    if (status === 1) {
      error = {
        name: "PerlError",
        message: string().replace(/\n+$/, ""),
        traceback: [],
      };
      results = [];
    } else if (status === 0) {
      const tag = byte();
      if (tag !== 4) throw new Error("Invalid Perl result");
      byte();
      const envelope = JSON.parse(string());
      results = envelope.results;
      error = envelope.error ?? undefined;
    } else throw new Error("Perl exited without returning a result");
    const stdout = string(),
      stderr = string();
    if (stdout) host.capture("log", stdout);
    if (stderr) host.capture("error", stderr);
  }
  if (encoder.encode(JSON.stringify(results)).length > 65536)
    throw new ExecutionLimitError("Result limit exceeded");
  return {
    logs: host.logs,
    results,
    ...(error ? { error } : {}),
    usage: meter.usage(instance.exports.memory),
  };
}
export { ExecutionLimitError };
