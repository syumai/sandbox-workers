import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const sources = JSON.parse(
  await readFile(new URL("./runtime-sources.json", import.meta.url), "utf8"),
);
for (const source of sources) {
  await mkdir("engine/.build/languages", { recursive: true });
  const path = `engine/.build/languages/${source.file}`;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {}
  const hash = (data) => createHash("sha256").update(data).digest("hex");
  if (!bytes || hash(bytes) !== source.sha256) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Download failed: ${source.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== source.sha256)
      throw new Error(`Checksum mismatch: ${source.file}`);
    await writeFile(path, bytes);
  }
  if (source.file.endsWith(".zip")) {
    const lang = source.file.split(".")[0];
    await mkdir(`packages/${lang}/dist`, { recursive: true });
    await copyFile(path, `packages/${lang}/dist/stdlib.bin`);
  }
}
