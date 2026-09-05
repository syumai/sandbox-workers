export const javascriptRuntime = {
  id: "javascript",
  name: "JavaScript",
  package: "@sandbox-workers/javascript",
  version: "0.1.0",
  engine: "SpiderMonkey / Fastly 3.45.0",
  enabled: true,
  mode: "async-function",
  capabilities: ["console", "json-input", "promises", "web-builtins"],
  limits: {
    codeBytes: 65536,
    requestBytes: 98304,
    fuel: 5000000,
    memoryBytes: 67108864,
  },
} as const;
