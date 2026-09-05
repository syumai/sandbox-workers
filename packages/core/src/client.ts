import type { ExecutionResult, LanguageEngine } from "./protocol.js";
export type { JsonValue } from "./protocol.js";
export interface RunCodeOptions {
  envVars?: Record<string, string | undefined>;
}
/** HTTP/transport failures are distinct from a guest execution failure (`error` on the result). */
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
    async runCode(
      code: string,
      options: RunCodeOptions = {},
    ): Promise<ExecutionResult> {
      const envVars = options.envVars
        ? Object.fromEntries(
            Object.entries(options.envVars).filter(
              ([, value]) => value !== undefined,
            ),
          )
        : undefined;
      const response = await binding.fetch(
        new Request("https://sandbox.internal/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ language, code, envVars }),
        }),
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SandboxTransportError(
          response.status,
          "Sandbox returned a non-JSON response",
        );
      }
      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          body.error &&
          typeof body.error === "object" &&
          "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : "Sandbox request failed";
        throw new SandboxTransportError(response.status, message);
      }
      if (
        !body ||
        typeof body !== "object" ||
        !("results" in body) ||
        !Array.isArray((body as { results: unknown }).results) ||
        !("logs" in body) ||
        typeof (body as { logs: unknown }).logs !== "object" ||
        (body as { logs: unknown }).logs === null
      )
        throw new SandboxTransportError(
          response.status,
          "Invalid sandbox response",
        );
      return body as ExecutionResult;
    },
  };
}
