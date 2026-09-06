---
title: Manage files
description: Read, write, and organize files under /workspace with the typed client and from guest code.
---

Every sandbox owns a writable `/workspace` directory, reachable both from guest code and from the caller through a files API. `/workspace` is shared by every code context in the sandbox, so files written from one context are visible from another. This guide shows you how to work with those files from your Worker and from the code you execute.

## Use the client's file methods

```ts
import { getSandbox } from "@sandbox-workers/core";

const sandbox = getSandbox(env.SANDBOX, "user-42");
```

### Write a file

```ts
await sandbox.writeFile("/workspace/app.py", "print('hi')");
// content is a string, Uint8Array, or ReadableStream<Uint8Array>; pass { encoding: "base64" } for base64 strings
```

### Read a file

```ts
const file = await sandbox.readFile("/workspace/app.py");
console.log(file.content);

const stream = await sandbox.readFile("/workspace/image.png", { encoding: "none" });
// stream.content is a ReadableStream<Uint8Array>
```

### List files

```ts
const { files } = await sandbox.listFiles("/workspace", { recursive: true });
```

### Create a directory

```ts
await sandbox.mkdir("/workspace/project/src", { recursive: true });
```

### Delete a file

```ts
await sandbox.deleteFile("/workspace/old.txt", { force: true });
// a directory needs recursive: true; force: true ignores a missing path
```

### Rename or move a file

```ts
await sandbox.renameFile("/workspace/draft.md", "/workspace/final.md");
await sandbox.moveFile("/workspace/report.csv", "/workspace/archive/report.csv");
// move additionally requires the destination's parent directory to exist
```

### Check whether a file exists

```ts
await sandbox.exists("/workspace/config.json");
```

See [the files API reference](/api/files) for each method's full signature and return type.

## Access files from guest code

### JavaScript

`fs` is a host-backed synchronous subset of Node's `fs`:

```js
fs.readFileSync(path, "utf8"); // string; without an encoding, a Uint8Array
fs.writeFileSync(path, data); // string or Uint8Array
fs.readdirSync(path, { withFileTypes });
fs.mkdirSync(path, { recursive });
fs.rmSync(path, { recursive, force });
fs.renameSync(from, to);
fs.existsSync(path);
fs.statSync(path); // { size, mtimeMs, isFile(), isDirectory() }
```

Errors carry the same Node-style `code` values as the client's file methods. `import()` (and static `import` inside a module loaded through it) is served from `/workspace`: `./` and `../` specifiers resolve against the importing module, and only `.js`/`.mjs` and `.json` (with `{type: "json"}`) files are served — anything outside `/workspace` fails to resolve.

### Python

`sys.path` includes `/workspace`, so modules written there can be imported. `os.chdir(cwd)` changes the working directory used by relative paths; in a code context, the final `os.getcwd()` is persisted across executions when it is under `/workspace`.

### Perl

`chdir($cwd)` changes the working directory. In a code context, `Cwd::getcwd()` is persisted across executions.

## Limits

- 1 MiB per file
- 16 MiB per workspace
- 4096 entries

## Handle errors

A file operation failure throws the matching `SandboxError` subclass — `FileNotFoundError`, `FileExistsError`, `FileTooLargeError`, `PermissionDeniedError`, or `FileSystemError` — with the path and operation on `error.context`, and, for filesystem failures, the Node-style errno in `error.context.errno`.

```ts
import { FileNotFoundError } from "@sandbox-workers/core";

try {
  await sandbox.readFile("/workspace/missing.txt");
} catch (error) {
  if (error instanceof FileNotFoundError) {
    // error.code === "FILE_NOT_FOUND", error.httpStatus === 404
  }
}
```

See [errors](/api/errors) for the full `SandboxError` hierarchy and error code table.
