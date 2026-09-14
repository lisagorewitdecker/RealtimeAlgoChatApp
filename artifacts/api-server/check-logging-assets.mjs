import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(artifactDir, process.argv[2] ?? "dist");
const requiredAssets = [
  "thread-stream-worker.mjs",
  "pino-worker.mjs",
  "pino-file.mjs",
  "pino-pretty.mjs",
];

const failures = [];
for (const asset of requiredAssets) {
  try {
    await access(path.join(distDir, asset));
  } catch {
    failures.push(`missing ${asset}`);
  }
}

try {
  const bundle = await readFile(path.join(distDir, "index.mjs"), "utf8");
  for (const asset of requiredAssets) {
    if (!bundle.includes(`"./${asset}"`)) {
      failures.push(`index.mjs does not reference ${asset}`);
    }
  }
  if (/const outputDir = ["'][/\\]/.test(bundle)) {
    failures.push("index.mjs contains an absolute logging-worker output path");
  }
} catch {
  failures.push("missing index.mjs");
}

if (failures.length > 0) {
  console.error(
    `Logging worker asset check failed in ${distDir}:\n- ${failures.join("\n- ")}`,
  );
  process.exitCode = 1;
}