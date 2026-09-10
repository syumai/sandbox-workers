import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
await mkdir("dist", { recursive: true });
for (const name of ["core", "interpreter", "cli", "javascript", "python", "perl", "ruby"])
  execFileSync("pnpm", ["pack", "--pack-destination", resolve("dist")], {
    cwd: `packages/${name}`,
    stdio: "inherit",
  });
