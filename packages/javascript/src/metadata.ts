export const javascriptRuntime = {
  id: "javascript",
  name: "JavaScript",
  package: "@sandbox-workers/javascript",
  version: "0.1.0",
  engine: "SpiderMonkey 147 / goccy spidermonkey-wasm v0.2.6",
  enabled: true,
  mode: "script",
  capabilities: [
    "console",
    "env-vars",
    "last-expression-result",
    "promises",
    "intl",
  ],
  limits: {
    codeBytes: 65536,
    requestBytes: 98304,
    fuel: 50000000,
    memoryBytes: 67108864,
  },
} as const;
