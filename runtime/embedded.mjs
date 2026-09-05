import { createWasi, budget, ExecutionLimitError } from "./wasi.mjs";
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
my $__sandbox_value = eval { (sub {
${payload.code}
})->() };
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
