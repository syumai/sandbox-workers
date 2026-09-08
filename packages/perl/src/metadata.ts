export const perlRuntime = {
  id: "perl",
  name: "Perl",
  package: "@sandbox-workers/perl",
  version: "0.1.1",
  engine: "Perl 5.42.2 / goccy v0.2.1",
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
    fuel: 10000000,
    memoryBytes: 67108864,
  },
} as const;
