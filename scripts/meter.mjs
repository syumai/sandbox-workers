import { instrument } from "./instrument.mjs";
await instrument(
  "engine/.build/raw.wasm",
  "packages/javascript/dist/engine.wasm",
);
