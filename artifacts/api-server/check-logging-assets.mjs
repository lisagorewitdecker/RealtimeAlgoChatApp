import { access, readFile, readdir } from "node:fs/promises";
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
  await access(path.join(distDir, "index.mjs"));

  // The build is code-split: pino (and the worker path table it carries) may
  // live in a shared chunk rather than in index.mjs itself, so check the whole
  // set of bundles that index.mjs can load.
  const bundleFiles = (await readdir(distDir)).filter(
    (file) =>
      file === "index.mjs" ||
      file === "instrument.mjs" ||
      /^chunk-.*\.mjs$/.test(file),
  );
  const bundles = await Promise.all(
    bundleFiles.map(async (file) => ({
      file,
      contents: await readFile(path.join(distDir, file), "utf8"),
    })),
  );

  for (const asset of requiredAssets) {
    if (!bundles.some(({ contents }) => contents.includes(`"./${asset}"`))) {
      failures.push(`no bundle references ${asset}`);
    }
  }
  for (const { file, contents } of bundles) {
    if (/const outputDir = ["'][/\\]/.test(contents)) {
      failures.push(`${file} contains an absolute logging-worker output path`);
    }
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
