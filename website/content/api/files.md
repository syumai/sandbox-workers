---
title: Files
description: Read, write, and manage files in a sandbox's shared workspace.
---

**Mode:** stateful only — requires the `Sandbox` Durable Object. See [Stateful mode](/stateful).

Every sandbox owns a writable `/workspace` directory, shared by every code context in that sandbox — a file written from one context (or through these methods) is visible to every other context and to a later `runCode()` in the same sandbox. See [Manage files](/stateful/manage-files) for a task-oriented walkthrough.

Paths must be absolute under `/workspace`. A path is normalized before use, and one that would resolve outside `/workspace` (for example via `..`) is rejected with `PERMISSION_DENIED`. Entries whose name starts with `.` are hidden: `listFiles()` omits them unless `includeHidden` is set.

## Methods

### `writeFile()`

Write content to a file, creating it if it doesn't exist.

```ts
await sandbox.writeFile(
  path: string,
  content: string | Uint8Array | ReadableStream<Uint8Array>,
  options?: WriteFileOptions,
): Promise<WriteFileResult>
```

**Parameters**:

- `path` — absolute path under `/workspace`.
- `content` — a string, a `Uint8Array`, or a `ReadableStream<Uint8Array>` for binary data (both are read fully and sent as base64 automatically).
- `options` (optional):
  - `encoding` — any string, for string `content`: `"utf8"` is normalized to `"utf-8"`; anything else is forwarded unchanged (the server still rejects anything but `"utf-8"`/`"base64"` with 400). Ignored for `Uint8Array`/`ReadableStream` content, which is always sent as base64.

**Returns**: `Promise<WriteFileResult>`.

```ts
await sandbox.writeFile("/workspace/app.js", "console.log('hi');");
await sandbox.writeFile("/workspace/image.png", pngBytes); // Uint8Array
await sandbox.writeFile("/workspace/upload.bin", request.body); // ReadableStream<Uint8Array>
```

### `readFile()`

Read a file's content.

```ts
await sandbox.readFile(path: string, options: { encoding: "none" }): Promise<ReadFileStreamResult>
await sandbox.readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult>
```

**Parameters**:

- `path` — absolute path under `/workspace`.
- `options` (optional):
  - `encoding` — `"utf-8"` or `"base64"` to force how `content` is returned, or `"none"` to get the content as a `ReadableStream<Uint8Array>` instead (the request still asks the server for base64; the client decodes it into a single-chunk stream).

**Returns**: `Promise<ReadFileResult>`, or `Promise<ReadFileStreamResult>` when `encoding: "none"` is given.

```ts
const file = await sandbox.readFile("/workspace/package.json");
JSON.parse(file.content);

const stream = await sandbox.readFile("/workspace/image.png", { encoding: "none" });
stream.content; // ReadableStream<Uint8Array>
```

### `mkdir()`

Create a directory.

```ts
await sandbox.mkdir(path: string, options?: { recursive?: boolean }): Promise<MkdirResult>
```

**Parameters**:

- `path` — absolute path under `/workspace`.
- `options` (optional):
  - `recursive` — create missing parent directories.

**Returns**: `Promise<MkdirResult>`.

```ts
await sandbox.mkdir("/workspace/src/lib", { recursive: true });
```

### `deleteFile()`

Delete a file or directory.

```ts
await sandbox.deleteFile(path: string, options?: DeleteFileOptions): Promise<DeleteFileResult>
```

**Parameters**:

- `path` — absolute path under `/workspace`.
- `options` (optional):
  - `recursive` — required to delete a directory at all (even an empty one) — without it, `deleteFile()` on a directory fails with `IS_DIRECTORY`.
  - `force` — don't error if `path` doesn't exist.

**Returns**: `Promise<DeleteFileResult>`.

```ts
await sandbox.deleteFile("/workspace/tmp", { recursive: true, force: true });
```

### `renameFile()`

Rename (or move) a file or directory within `/workspace`.

```ts
await sandbox.renameFile(oldPath: string, newPath: string): Promise<RenameFileResult>
```

**Parameters**:

- `oldPath` — current absolute path.
- `newPath` — new absolute path.

**Returns**: `Promise<RenameFileResult>`.

```ts
await sandbox.renameFile("/workspace/draft.md", "/workspace/final.md");
```

`renameFile` and `moveFile` perform the same underlying operation; `moveFile` additionally requires the destination's parent directory to already exist.

### `moveFile()`

Move a file or directory.

```ts
await sandbox.moveFile(sourcePath: string, destinationPath: string): Promise<MoveFileResult>
```

**Parameters**:

- `sourcePath` — current absolute path.
- `destinationPath` — new absolute path; its parent directory must already exist.

**Returns**: `Promise<MoveFileResult>`.

```ts
await sandbox.moveFile("/workspace/report.csv", "/workspace/archive/report.csv");
```

### `listFiles()`

List the contents of a directory.

```ts
await sandbox.listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult>
```

**Parameters**:

- `path` — absolute path under `/workspace`.
- `options` (optional):
  - `recursive` — list subdirectories' contents too.
  - `includeHidden` — include entries whose name starts with `.`.

**Returns**: `Promise<ListFilesResult>`.

```ts
const { files } = await sandbox.listFiles("/workspace", { recursive: true });
```

### `exists()`

Check whether a path exists.

```ts
await sandbox.exists(path: string): Promise<FileExistsResult>
```

**Parameters**:

- `path` — absolute path under `/workspace`.

**Returns**: `Promise<FileExistsResult>`.

```ts
const { exists } = await sandbox.exists("/workspace/config.json");
if (!exists) await sandbox.writeFile("/workspace/config.json", "{}");
```

## Types

```ts
interface WriteFileOptions { encoding?: string; }

interface WriteFileResult { success: boolean; path: string; timestamp: string; }

interface ReadFileOptions { encoding?: "utf-8" | "utf8" | "base64"; }

interface ReadFileResult {
  success: boolean;
  path: string;
  content: string;
  timestamp: string;
  encoding?: "utf-8" | "base64";
  isBinary?: boolean;
  mimeType?: string;
  size?: number;
}

interface ReadFileStreamResult {
  success: true;
  path: string;
  content: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
  timestamp: string;
}

interface MkdirResult { success: boolean; path: string; recursive: boolean; timestamp: string; }

interface DeleteFileResult { success: boolean; path: string; timestamp: string; }

interface RenameFileResult { success: boolean; path: string; newPath: string; timestamp: string; }

interface MoveFileResult { success: boolean; path: string; newPath: string; timestamp: string; }

interface ListFilesResult {
  success: boolean;
  path: string;
  files: FileInfo[];
  count: number;
  timestamp: string;
}

interface FileExistsResult { success: boolean; path: string; exists: boolean; timestamp: string; }

interface FileInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: "file" | "directory" | "symlink" | "other"; // the server currently only ever emits "file" or "directory"
  size: number;
  modifiedAt: string;
  mode: string;
  permissions: { readable: boolean; writable: boolean; executable: boolean };
}
```

### Limits

1 MiB per file, 16 MiB total per workspace, and 4096 entries per workspace. Writing past these limits fails with `FILE_TOO_LARGE` or `NO_SPACE` — see [Errors](/api/errors).
