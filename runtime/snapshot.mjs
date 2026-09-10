// Ported to @sandbox-workers/interpreter/snapshot (packages/interpreter/src/
// snapshot.ts); this file re-exports it so every existing importer
// (runtime/javascript.mjs, runtime/embedded.mjs, tests/*.test.mjs) keeps
// working unchanged. Run `pnpm --filter @sandbox-workers/interpreter build`
// first. Deleted in phase 4 along with the rest of runtime/.
export * from "@sandbox-workers/interpreter/snapshot";
