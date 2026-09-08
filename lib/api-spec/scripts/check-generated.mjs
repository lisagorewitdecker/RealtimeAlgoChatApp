import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const generatedPaths = [
  "lib/api-client-react/src/generated",
  "lib/api-zod/src/generated",
  "lib/api-zod/src/index.ts",
];

function collectFiles(rootPath, files = new Map()) {
  if (!existsSync(rootPath)) {
    return files;
  }

  const entry = statSync(rootPath);
  if (entry.isFile()) {
    files.set(relative(workspaceRoot, rootPath), readFileSync(rootPath));
    return files;
  }

  for (const child of readdirSync(rootPath)) {
    collectFiles(join(rootPath, child), files);
  }
  return files;
}

function snapshotGeneratedFiles() {
  const files = new Map();
  for (const generatedPath of generatedPaths) {
    collectFiles(join(workspaceRoot, generatedPath), files);
  }
  return files;
}

function findDifferences(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].sort().filter((path) => {
    const previous = before.get(path);
    const current = after.get(path);
    return !previous || !current || !previous.equals(current);
  });
}

function snapshotPaths(destination) {
  const backups = [];
  for (const generatedPath of generatedPaths) {
    const source = join(workspaceRoot, generatedPath);
    const backup = join(destination, generatedPath);
    if (existsSync(source)) {
      cpSync(source, backup, { recursive: true });
      backups.push({ source, backup });
    }
  }
  return backups;
}

function restorePaths(backups) {
  for (const generatedPath of generatedPaths) {
    rmSync(join(workspaceRoot, generatedPath), {
      recursive: true,
      force: true,
    });
  }
  for (const { source, backup } of backups) {
    cpSync(backup, source, { recursive: true });
  }
}

const temporaryDirectory = mkdtempSync(
  join(workspaceRoot, ".api-codegen-check-"),
);
const backups = snapshotPaths(temporaryDirectory);
const before = snapshotGeneratedFiles();
let codegenError;

try {
  execFileSync("pnpm", ["--filter", "@workspace/api-spec", "run", "codegen"], {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
} catch (error) {
  codegenError = error;
}

const after = snapshotGeneratedFiles();
const differences = findDifferences(before, after);
restorePaths(backups);
rmSync(temporaryDirectory, { recursive: true, force: true });

if (codegenError) {
  console.error(
    "API client regeneration failed; generated files were restored to their original state.",
  );
  process.exit(codegenError.status || 1);
}

if (differences.length > 0) {
  console.error("Generated API drift detected after regeneration:");
  for (const path of differences) {
    console.error(`- ${path}`);
  }
  console.error(
    "Run `pnpm --filter @workspace/api-spec run codegen` and commit the generated output.",
  );
  process.exit(1);
}

console.log("Generated API clients match the OpenAPI specification.");
