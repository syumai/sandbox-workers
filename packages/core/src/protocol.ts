export const MAX_REQUEST_BYTES = 96 * 1024;
export const MAX_CODE_BYTES = 64 * 1024;
const ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ExecutionRequest {
  code: string;
  envVars?: Record<string, string>;
}

export interface ExecutionLog {
  stdout: string[];
  stderr: string[];
}
export interface ExecutionUsage {
  fuelConsumed: number;
  fuelLimit: number;
  memoryBytes: number;
}
export interface ExecutionError {
  name: string;
  message: string;
  traceback: string[];
  lineNumber?: number;
}
export type ExecutionResultValue =
  | { text: string; json?: undefined }
  | { json: JsonValue; text?: undefined };
export interface ExecutionResult {
  code: string;
  language: string;
  engine: string;
  durationMs: number;
  logs: ExecutionLog;
  results: ExecutionResultValue[];
  error?: ExecutionError;
  usage?: ExecutionUsage;
}

export interface LanguageEngine {
  fetch(request: Request): Promise<Response>;
}

export async function readExecution(
  request: Request,
): Promise<ExecutionRequest> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(415, "Content-Type must be application/json");
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES)
    throw new ApiError(413, "Request too large");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(400, "Expected an object");
  const value = body as Record<string, unknown>;
  if ("input" in value)
    throw new ApiError(
      400,
      "input is no longer supported; pass data with envVars",
    );
  if ("language" in value)
    throw new ApiError(
      400,
      "language is no longer supported; the runtime is selected by the Service Binding",
    );
  if (typeof value.code !== "string" || !value.code.trim())
    throw new ApiError(400, "Non-empty code is required");
  if (new TextEncoder().encode(value.code).length > MAX_CODE_BYTES)
    throw new ApiError(413, "Code exceeds 64 KiB");
  let envVars: Record<string, string> | undefined;
  if (value.envVars !== undefined) {
    if (
      typeof value.envVars !== "object" ||
      value.envVars === null ||
      Array.isArray(value.envVars)
    )
      throw new ApiError(400, "envVars must be an object");
    envVars = {};
    for (const [key, raw] of Object.entries(
      value.envVars as Record<string, unknown>,
    )) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== "string")
        throw new ApiError(400, "envVars values must be strings");
      if (!ENV_VAR_KEY.test(key)) continue;
      envVars[key] = raw;
    }
  }
  return { code: value.code, ...(envVars ? { envVars } : {}) };
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function errorResponse(error: unknown): Response {
  return Response.json(
    {
      error: {
        name: "ApiError",
        message:
          error instanceof ApiError ? error.message : "Engine execution failed",
      },
    },
    { status: error instanceof ApiError ? error.status : 502 },
  );
}
