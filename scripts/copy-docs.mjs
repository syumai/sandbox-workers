import { cp, mkdir, readdir, rm } from "node:fs/promises";
await mkdir("dist/ui", { recursive: true });
// Blume owns /docs plus its generated assets. Never replace the Playground entrypoint.
for (const entry of await readdir("website/dist", { withFileTypes: true })) {
  if (entry.name === "index.html") continue;
  const target = `dist/ui/${entry.name}`;
  await rm(target, { recursive: true, force: true });
  await cp(`website/dist/${entry.name}`, target, { recursive: true });
}
