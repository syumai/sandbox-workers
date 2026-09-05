export const pythonRuntime = {
  id: "python",
  name: "Python",
  package: "@sandbox-workers/python",
  version: "0.1.0",
  engine: "CPython 3.14.6 / goccy v0.2.0",
  enabled: true,
  mode: "function-body",
  capabilities: ["stdout", "json-input", "standard-library"],
  limits: {
    codeBytes: 65536,
    requestBytes: 98304,
    fuel: 100000000,
    memoryBytes: 67108864,
  },
} as const;
