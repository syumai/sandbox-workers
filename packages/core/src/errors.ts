// Error classes for the SDK-parity client (see docs/sdk-parity-design.md,
// "Errors"). These mirror `@cloudflare/sandbox`'s error hierarchy so code
// written against that SDK ports with few changes.

export const ErrorCode = {
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_EXISTS: "FILE_EXISTS",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  IS_DIRECTORY: "IS_DIRECTORY",
  NOT_DIRECTORY: "NOT_DIRECTORY",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  NO_SPACE: "NO_SPACE",
  FILESYSTEM_ERROR: "FILESYSTEM_ERROR",
  CONTEXT_NOT_FOUND: "CONTEXT_NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  CODE_EXECUTION_ERROR: "CODE_EXECUTION_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NOT_SUPPORTED: "NOT_SUPPORTED",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const HTTP_STATUS_FOR_CODE: Record<ErrorCode, number> = {
  FILE_NOT_FOUND: 404,
  FILE_EXISTS: 409,
  PERMISSION_DENIED: 403,
  IS_DIRECTORY: 400,
  NOT_DIRECTORY: 400,
  FILE_TOO_LARGE: 413,
  NO_SPACE: 500,
  FILESYSTEM_ERROR: 500,
  CONTEXT_NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CODE_EXECUTION_ERROR: 500,
  INTERNAL_ERROR: 500,
  NOT_SUPPORTED: 403,
};
export function httpStatusForCode(code: ErrorCode): number {
  return HTTP_STATUS_FOR_CODE[code] ?? 500;
}

const ERROR_CODE_FOR_ERRNO: Record<string, ErrorCode> = {
  ENOENT: ErrorCode.FILE_NOT_FOUND,
  EEXIST: ErrorCode.FILE_EXISTS,
  EACCES: ErrorCode.PERMISSION_DENIED,
  EISDIR: ErrorCode.IS_DIRECTORY,
  ENOTDIR: ErrorCode.NOT_DIRECTORY,
  EFBIG: ErrorCode.FILE_TOO_LARGE,
  ENOSPC: ErrorCode.NO_SPACE,
};
/** ENOTEMPTY and anything else not listed above map to FILESYSTEM_ERROR. */
export function errorCodeForErrno(errno: string): ErrorCode {
  return ERROR_CODE_FOR_ERRNO[errno] ?? ErrorCode.FILESYSTEM_ERROR;
}

/** Mirrors the SDK's `Operation` constants, used as `ErrorResponse.operation`. */
export const Operation = {
  FILE_READ: "file.read",
  FILE_WRITE: "file.write",
  FILE_DELETE: "file.delete",
  FILE_MOVE: "file.move",
  FILE_RENAME: "file.rename",
  FILE_STAT: "file.stat",
  DIRECTORY_CREATE: "directory.create",
  DIRECTORY_LIST: "directory.list",
  CODE_EXECUTE: "code.execute",
  CODE_CONTEXT_CREATE: "code.context.create",
  CODE_CONTEXT_DELETE: "code.context.delete",
} as const;
export type OperationType = (typeof Operation)[keyof typeof Operation];

export interface ErrorResponse<TContext = Record<string, unknown>> {
  code: ErrorCode;
  message: string;
  context: TContext;
  httpStatus: number;
  timestamp: string;
  operation?: OperationType;
  /** Not currently emitted by any server in this repo; typed for SDK parity. */
  suggestion?: string;
  /** Not currently emitted by any server in this repo; typed for SDK parity. */
  documentation?: string;
}

export class SandboxError<
  TContext = Record<string, unknown>,
> extends Error {
  constructor(
    public readonly errorResponse: ErrorResponse<TContext>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse.message, options);
    this.name = "SandboxError";
  }
  get code(): ErrorCode {
    return this.errorResponse.code;
  }
  get context(): TContext {
    return this.errorResponse.context;
  }
  get httpStatus(): number {
    return this.errorResponse.httpStatus;
  }
  get timestamp(): string {
    return this.errorResponse.timestamp;
  }
  get operation(): OperationType | undefined {
    return this.errorResponse.operation;
  }
  toJSON(): ErrorResponse<TContext> {
    return this.errorResponse;
  }
}

export class FileNotFoundError extends SandboxError<{
  path: string;
  operation: string;
}> {
  constructor(
    errorResponse: ErrorResponse<{ path: string; operation: string }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "FileNotFoundError";
  }
}
export class FileExistsError extends SandboxError<{
  path: string;
  operation: string;
}> {
  constructor(
    errorResponse: ErrorResponse<{ path: string; operation: string }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "FileExistsError";
  }
}
export class FileTooLargeError extends SandboxError<{
  path: string;
  operation: string;
  maxSize: number;
  actualSize: number;
}> {
  constructor(
    errorResponse: ErrorResponse<{
      path: string;
      operation: string;
      maxSize: number;
      actualSize: number;
    }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "FileTooLargeError";
  }
}
export class PermissionDeniedError extends SandboxError<{
  path: string;
  operation: string;
}> {
  constructor(
    errorResponse: ErrorResponse<{ path: string; operation: string }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "PermissionDeniedError";
  }
}
export class FileSystemError extends SandboxError<{
  path: string;
  operation: string;
}> {
  constructor(
    errorResponse: ErrorResponse<{ path: string; operation: string }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "FileSystemError";
  }
}
export class ContextNotFoundError extends SandboxError<{
  contextId: string;
}> {
  constructor(
    errorResponse: ErrorResponse<{ contextId: string }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "ContextNotFoundError";
  }
}
export class NotSupportedError extends SandboxError<{
  feature: string;
}> {
  constructor(
    errorResponse: ErrorResponse<{ feature: string }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "NotSupportedError";
  }
}
export class ValidationFailedError extends SandboxError<{
  validationErrors?: Array<{ field: string; message: string }>;
}> {
  constructor(
    errorResponse: ErrorResponse<{
      validationErrors?: Array<{ field: string; message: string }>;
    }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "ValidationFailedError";
  }
}
export class CodeExecutionError extends SandboxError<{
  contextId?: string;
  ename?: string;
  evalue?: string;
}> {
  constructor(
    errorResponse: ErrorResponse<{
      contextId?: string;
      ename?: string;
      evalue?: string;
    }>,
    options?: { cause?: unknown },
  ) {
    super(errorResponse, options);
    this.name = "CodeExecutionError";
  }
}

/**
 * Thrown by an engine (or its WASI host) when a guest execution hits a
 * resource limit -- fuel exhaustion, an output/console limit, or a result
 * limit (see `runtime/wasi.mjs`, `runtime/javascript.mjs`,
 * `runtime/embedded.mjs`). Not a `SandboxError`: this is an engine-internal
 * signal caught by the interpreter/runtime Worker and turned into a regular
 * `{ error: { name: "ExecutionLimitError", ... } }` execution result, never
 * serialized over the wire itself. `runtime/javascript.mjs` sets an
 * additional `trap` property on some instances (a plain field assignment --
 * no special support is needed here beyond being an ordinary `Error`
 * subclass) to distinguish a safe interrupt (the Wasm instance survives)
 * from the hard fuel backstop (it doesn't).
 */
export class ExecutionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionLimitError";
  }
}

function isErrorResponseShape(
  body: unknown,
): body is { code: string; message: string; [key: string]: unknown } {
  return (
    !!body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).code === "string" &&
    typeof (body as Record<string, unknown>).message === "string"
  );
}

/**
 * Maps a parsed error response body to a `SandboxError` subclass, or
 * `body`'s absence/malformed shape to a generic `INTERNAL_ERROR` describing
 * the HTTP status (like the SDK does for non-JSON error bodies).
 */
export function createErrorFromResponse(
  body: unknown,
  options?: { cause?: unknown; status?: number; statusText?: string },
): SandboxError {
  const causeOptions =
    options?.cause !== undefined ? { cause: options.cause } : undefined;
  if (!isErrorResponseShape(body)) {
    const status = options?.status ?? 500;
    const statusText = options?.statusText ?? "";
    return new SandboxError(
      {
        code: ErrorCode.INTERNAL_ERROR,
        message: `HTTP ${status}: ${statusText}`,
        context: {},
        httpStatus: status,
        timestamp: new Date().toISOString(),
      },
      causeOptions,
    );
  }
  const code = body.code as ErrorCode;
  const errorResponse: ErrorResponse<Record<string, unknown>> = {
    code,
    message: body.message,
    context:
      typeof body.context === "object" && body.context !== null
        ? (body.context as Record<string, unknown>)
        : {},
    httpStatus:
      typeof body.httpStatus === "number"
        ? body.httpStatus
        : httpStatusForCode(code),
    timestamp:
      typeof body.timestamp === "string"
        ? body.timestamp
        : new Date().toISOString(),
    ...(typeof body.operation === "string"
      ? { operation: body.operation as OperationType }
      : {}),
  };
  switch (code) {
    case ErrorCode.FILE_NOT_FOUND:
      return new FileNotFoundError(
        errorResponse as ErrorResponse<{ path: string; operation: string }>,
        causeOptions,
      );
    case ErrorCode.FILE_EXISTS:
      return new FileExistsError(
        errorResponse as ErrorResponse<{ path: string; operation: string }>,
        causeOptions,
      );
    case ErrorCode.FILE_TOO_LARGE:
      return new FileTooLargeError(
        errorResponse as ErrorResponse<{
          path: string;
          operation: string;
          maxSize: number;
          actualSize: number;
        }>,
        causeOptions,
      );
    case ErrorCode.PERMISSION_DENIED:
      return new PermissionDeniedError(
        errorResponse as ErrorResponse<{ path: string; operation: string }>,
        causeOptions,
      );
    case ErrorCode.NO_SPACE:
    case ErrorCode.IS_DIRECTORY:
    case ErrorCode.NOT_DIRECTORY:
    case ErrorCode.FILESYSTEM_ERROR:
      return new FileSystemError(
        errorResponse as ErrorResponse<{ path: string; operation: string }>,
        causeOptions,
      );
    case ErrorCode.CONTEXT_NOT_FOUND:
      return new ContextNotFoundError(
        errorResponse as ErrorResponse<{ contextId: string }>,
        causeOptions,
      );
    case ErrorCode.VALIDATION_FAILED:
      return new ValidationFailedError(
        errorResponse as ErrorResponse<{
          validationErrors?: Array<{ field: string; message: string }>;
        }>,
        causeOptions,
      );
    case ErrorCode.CODE_EXECUTION_ERROR:
      return new CodeExecutionError(
        errorResponse as ErrorResponse<{
          contextId?: string;
          ename?: string;
          evalue?: string;
        }>,
        causeOptions,
      );
    case ErrorCode.NOT_SUPPORTED:
      return new NotSupportedError(
        errorResponse as ErrorResponse<{ feature: string }>,
        causeOptions,
      );
    default:
      return new SandboxError(errorResponse, causeOptions);
  }
}
