---
title: API reference
description: The language-neutral JSON execution contract.
---

## POST /execute

Use `Content-Type: application/json`.

| Field      | Type       | Required | Meaning                                      |
| ---------- | ---------- | -------- | -------------------------------------------- |
| `language` | string     | No       | `javascript`, `python`, `perl`, or `ruby`    |
| `code`     | string     | Yes      | Nonempty function body; maximum 64 KiB UTF-8 |
| `input`    | JSON value | No       | Value exposed to the function                |

The gateway defaults to JavaScript. Individual engine Workers default to their own language. An explicitly mismatched language is rejected. The complete request is limited to 96 KiB.

```json
{ "language": "ruby", "code": "return input['x'] ** 2", "input": { "x": 12 } }
```

## Responses

```json
{
  "ok": true,
  "result": 144,
  "logs": [],
  "language": "ruby",
  "engine": "CRuby 4.0.0 / ruby.wasm 2.10.1",
  "durationMs": 200,
  "usage": {
    "fuelConsumed": 13000000,
    "fuelLimit": 30000000,
    "memoryBytes": 67305472
  }
}
```

Metrics above are illustrative. `durationMs` is elapsed engine execution time; it is not a billing measurement. Fuel includes engine initialization and library loading.

```json
{
  "ok": false,
  "language": "python",
  "error": { "name": "EngineError", "message": "division by zero" },
  "logs": [],
  "durationMs": 500
}
```

| Status | Meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| 200    | Successful execution; also JavaScript guest errors (check `ok`)        |
| 400    | Invalid JSON/language, engine errors, or Python/Perl/Ruby guest errors |
| 405    | Wrong HTTP method                                                      |
| 413    | Request or code too large                                              |
| 415    | Unsupported Content-Type                                               |
| 422    | Fuel or detected host output limit exceeded                            |
| 502    | Gateway could not call a Service Binding                               |

Always check `ok`. Resource failures detected at other engine layers can surface as engine errors. JavaScript BigInt values become strings ending in `n`; JSON precision limits apply to numeric results.

## GET /languages

The Playground gateway returns `{languages:[...]}` with runtime IDs, names, package versions, engine names, execution modes, capabilities, and configured limits. Individual engine Workers expose only `/execute`.

## Raw Service Binding calls

The request URL may use any placeholder hostname; the binding determines the destination Worker. The path must be `/execute`. This API provides no host-network capability to the submitted code.
