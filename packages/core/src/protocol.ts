export const MAX_REQUEST_BYTES = 96 * 1024;
export const MAX_CODE_BYTES = 64 * 1024;
export interface ExecutionRequest {
  language: string;
  code: string;
  input?: unknown;
}
export interface LanguageEngine {
  fetch(request: Request): Promise<Response>;
}
export async function readExecution(
  request: Request,
  defaultLanguage = "javascript",
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
  if (typeof value.code !== "string" || !value.code.trim())
    throw new ApiError(400, "Non-empty code is required");
  if (new TextEncoder().encode(value.code).length > MAX_CODE_BYTES)
    throw new ApiError(413, "Code exceeds 64 KiB");
  const language = value.language ?? defaultLanguage;
  if (typeof language !== "string")
    throw new ApiError(400, "language must be a string");
  return { language, code: value.code, input: value.input };
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
      ok: false,
      error: {
        name: "ApiError",
        message:
          error instanceof ApiError ? error.message : "Engine execution failed",
      },
    },
    { status: error instanceof ApiError ? error.status : 502 },
  );
}
