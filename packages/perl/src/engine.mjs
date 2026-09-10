// The Perl-specific half of the wasmify embedded interpreter: driver
// scripts, envelope parsing, and the `WasmifyDriver` object
// `@sandbox-workers/interpreter/wasmify`'s runWasmify/bootWasmifySession/
// restoreWasmifySession drive. Ported from the Perl branches of
// the pre-split, now-deleted embedded.mjs.
import { invoke } from "@sandbox-workers/interpreter/wasmify";

const encoder = new TextEncoder();
const decode = (bytes) => new TextDecoder().decode(bytes);
const hexEncode = (str) =>
  Array.from(encoder.encode(str), (b) => b.toString(16).padStart(2, "0")).join("");

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

// Captures stdout/stderr into `host`, throws on an interpreter-level
// failure, and returns the driver's string result. Used for
// `driver.evaluate` (PERL_SESSION_BOOT at session boot; there is no
// post-restore hook for Perl, unlike Python's random reseed).
function evaluatePerlRaw(instance, handle, host, code) {
  const out = invokePerlRaw(instance, handle, code);
  if (out.stdout) host.capture("log", out.stdout);
  if (out.stderr) host.capture("error", out.stderr);
  if (!out.ok) throw new Error(out.error || "Perl execution failed");
  return out.value;
}

/** The Perl `WasmifyDriver` (see `@sandbox-workers/interpreter/wasmify`). */
export const perlDriver = {
  initMethod: "w_0_16",
  sessionBoot: PERL_SESSION_BOOT,
  evaluate(ctx, code) {
    return evaluatePerlRaw(ctx.instance, ctx.handle, ctx.host, code);
  },
  sessionExecute(ctx, { code, cwd, envVars }) {
    const call = `__sandbox_session_execute('${hexEncode(code)}', '${hexEncode(cwd)}', '${hexEncode(JSON.stringify(envVars ?? {}))}')`;
    const value = evaluatePerlRaw(ctx.instance, ctx.handle, ctx.host, call);
    const envelope = JSON.parse(value);
    return { results: envelope.results, error: envelope.error ?? undefined, cwd: envelope.cwd };
  },
  runOnce(ctx, { code }) {
    // %ENV entries come back as raw bytes; utf8::decode-ing them in place
    // trips Perl's "Wide character in setenv" warning on the next write-back
    // magic, so build a plain (non-magical) hash and alias *ENV to it.
    // Decoded %ENV values and "use utf8" literals are Perl character strings
    // (not bytes); without an encoding layer on STDOUT/STDERR, printing them
    // warns ("Wide character in print") and can write the wrong bytes. Set
    // the layer once so every print of a character string is UTF-8 encoded
    // exactly once, consistently with JSON::PP's own ->utf8 encode below.
    const driverCode = `use utf8;
binmode(STDOUT, ':encoding(UTF-8)');
binmode(STDERR, ':encoding(UTF-8)');
my %__sandbox_env = %ENV;
for my $__sandbox_key (keys %__sandbox_env) { utf8::decode($__sandbox_env{$__sandbox_key}); }
*ENV = \\%__sandbox_env;
use JSON::PP;
my $__sandbox_value = eval { do {
${code}
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
    // Unlike evaluate()/evaluatePerlRaw, a guest-level `die` here must come
    // back as a regular `{results: [], error: {name: "PerlError", ...}}`
    // result, not a thrown JS error -- so this calls invoke() directly and
    // parses the raw w_0_8 response itself, matching invokePerlRaw's shape
    // but handling status 1 (a die/exception) as data instead of a throw.
    const bytes = invoke(ctx.instance, "w_0_8", [
      [1, ctx.handle],
      [2, driverCode],
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
    let results, error;
    if (status === 1) {
      error = { name: "PerlError", message: string().replace(/\n+$/, ""), traceback: [] };
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
    if (stdout) ctx.host.capture("log", stdout);
    if (stderr) ctx.host.capture("error", stderr);
    return { results, error };
  },
};
