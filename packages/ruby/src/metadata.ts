export const rubyRuntime = {
  id: "ruby",
  name: "Ruby",
  package: "@sandbox-workers/ruby",
  version: "0.1.1",
  engine: "CRuby 4.0.0 / ruby.wasm 2.10.1",
  enabled: true,
  mode: "script",
  capabilities: [
    "stdout",
    "env-vars",
    "last-expression-result",
    "standard-library",
  ],
  limits: {
    codeBytes: 65536,
    requestBytes: 98304,
    fuel: 30000000,
    memoryBytes: 100663296,
  },
} as const;
