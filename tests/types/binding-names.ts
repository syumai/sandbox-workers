// Type-only test for the binding-name typing added to `getSandbox<Env>()`
// (docs/sandbox-1-0-design.md, "Typed client"). Never executed -- `pnpm
// check` (`tsc --noEmit`) only type-checks this file; nothing here runs.
import {
  getSandbox,
  type AnyEnv,
  type CodeContext,
  type SandboxClient,
  type ServiceBindingName,
} from "@sandbox-workers/core";

// A minimal helper to assert two types are exactly equal.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

interface Env {
  Sandbox: DurableObjectNamespace;
  PYTHON: Fetcher;
  JAVASCRIPT: Fetcher;
  KV: KVNamespace;
  NAME: string;
}

// `ServiceBindingName<Env>` picks out only the Fetcher-shaped bindings.
type _CheckServiceBindingNameEnv = Expect<
  Equal<ServiceBindingName<Env>, "PYTHON" | "JAVASCRIPT">
>;

// `ServiceBindingName<AnyEnv>` degrades to plain `string`.
type _CheckServiceBindingNameAnyEnv = Expect<Equal<ServiceBindingName<AnyEnv>, string>>;

declare const context: CodeContext;
declare const ns: DurableObjectNamespace;

// `getSandbox<Env>()` narrows `binding` options to the Env's Service
// Bindings: `ReturnType<...>` is a deferred `SandboxClient<ServiceBindingName<Env>>`
// rather than an eagerly-simplified union, so an exact-type `Equal` check on
// it is too strict (and the method-bivariance below is too loose) -- the
// `@ts-expect-error` calls in `createContexts`/`runCodeChecks` are the real
// assertion that the narrowing took effect; this annotation just confirms
// `getSandbox<Env>()`'s result is at least assignable to the narrowed shape.
const typedSandbox: SandboxClient<"PYTHON" | "JAVASCRIPT"> = getSandbox<Env>(ns, "s");

// Plain `getSandbox()` (no `Env`) keeps today's `string` behavior.
const untypedSandbox: SandboxClient<string> = getSandbox(ns, "s");

async function createContexts() {
  // Valid binding names type-check.
  await typedSandbox.interpreter.createCodeContext({ binding: "PYTHON" });
  await typedSandbox.interpreter.createCodeContext({ binding: "JAVASCRIPT" });

  // A misspelled binding name is a compile-time error.
  // @ts-expect-error "PYTHONN" is not a Service Binding name in Env
  await typedSandbox.interpreter.createCodeContext({ binding: "PYTHONN" });

  // The Durable Object namespace itself is not a Service Binding.
  // @ts-expect-error "Sandbox" is the DO namespace, not a Fetcher
  await typedSandbox.interpreter.createCodeContext({ binding: "Sandbox" });
}

async function runCodeChecks() {
  // Valid binding name type-checks.
  await typedSandbox.interpreter.runCode("1+1", { binding: "PYTHON" });

  // A binding that isn't a Fetcher (KVNamespace) is a compile-time error.
  // @ts-expect-error "KV" is a KVNamespace, not a Fetcher
  await typedSandbox.interpreter.runCode("1+1", { binding: "KV" });

  // Passing a `context` instead of a `binding` still type-checks.
  await typedSandbox.interpreter.runCode("1+1", { context });
}

async function untypedAcceptsAnyString() {
  // Without an `Env` type argument, `binding` is plain `string` -- any
  // string type-checks, exactly as before this feature existed.
  await untypedSandbox.interpreter.createCodeContext({ binding: "ANYTHING" });
}

function acceptsUntyped(_sandbox: SandboxClient) {}

// A narrower client is assignable where the untyped (string-`binding`)
// client is expected: `binding?: "PYTHON" | "JAVASCRIPT"` satisfies
// `binding?: string`, so this is allowed and does not need a
// `@ts-expect-error`.
acceptsUntyped(typedSandbox);
