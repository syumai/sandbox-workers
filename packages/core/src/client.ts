import type { ExecutionRequest, LanguageEngine } from "./protocol.js";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ExecutionLog {
  level: string;
  text: string;
}
export interface ExecutionUsage {
  fuelConsumed: number;
  fuelLimit: number;
  memoryBytes: number;
}
export type ExecutionResponse<T = JsonValue> = {
  language?: string;
  engine?: string;
  durationMs?: number;
  usage?: ExecutionUsage;
  logs?: ExecutionLog[];
} & (
  | { ok: true; result: T }
  | { ok: false; error: { name: string; message: string; stack?: string } }
);
/** HTTP/transport failures are distinct from a guest execution failure (ok: false). */
export class SandboxTransportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "SandboxTransportError";
  }
}
/** Only the supplied Service Binding is used; this client never calls a public URL. */
export function createSandbox(
  binding: LanguageEngine,
  language = "javascript",
) {
  return {
    async execute<T = JsonValue>(
      request: Omit<ExecutionRequest, "language">,
    ): Promise<ExecutionResponse<T>> {
      const response = await binding.fetch(
        new Request("https://sandbox.internal/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request, language }),
        }),
      );
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new SandboxTransportError(
          response.status,
          "Sandbox returned a non-JSON response",
        );
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new SandboxTransportError(
          response.status,
          "Sandbox returned invalid JSON",
        );
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("ok" in value) ||
        typeof value.ok !== "boolean"
      )
        throw new SandboxTransportError(
          response.status,
          "Invalid sandbox response",
        );
      if (response.status >= 500)
        throw new SandboxTransportError(
          response.status,
          "Sandbox service unavailable",
        );
      return value as ExecutionResponse<T>;
    },
  };
}
