import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REACT_PACKAGES = [
  "react",
  "react-dom",
  "@types/react",
  "@types/react-dom",
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..");

function collectPackageResolutions(node, resolutions) {
  if (!node || typeof node !== "object") {
    return;
  }

  for (const dependencyGroup of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = node[dependencyGroup];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }

    for (const [name, dependency] of Object.entries(dependencies)) {
      if (REACT_PACKAGES.includes(name) && dependency?.version) {
        const packageResolutions = resolutions.get(name);
        packageResolutions.versions.add(dependency.version);
        if (dependency.path) {
          packageResolutions.paths.add(dependency.path);
        }
      }
      collectPackageResolutions(dependency, resolutions);
    }
  }
}

export function inspectReactResolutions(listOutput) {
  const resolutions = new Map(
    REACT_PACKAGES.map((name) => [
      name,
      { versions: new Set(), paths: new Set() },
    ]),
  );

  for (const root of listOutput) {
    collectPackageResolutions(root, resolutions);
  }

  return resolutions;
}

export function formatResolutionSummary(resolutions) {
  return REACT_PACKAGES.map((name) => {
    const versions = [...resolutions.get(name).versions].sort();
    return `  ${name}: ${versions.length > 0 ? versions.join(", ") : "missing"}`;
  }).join("\n");
}

export function assertStableReactResolutions(resolutions) {
  const driftedPackages = REACT_PACKAGES.filter((name) => {
    const resolution = resolutions.get(name);
    return resolution.versions.size !== 1 || resolution.paths.size !== 1;
  });

  if (driftedPackages.length === 0) {
    return;
  }

  const error = new Error(
    [
      "Mockup preview React dependency resolution drift detected after a clean install.",
      "Expected exactly one resolved version and package path for each React runtime/type package.",
      formatResolutionSummary(resolutions),
      `Drifted packages: ${driftedPackages.join(", ")}`,
      "Align the React and @types/react catalog/direct dependency versions, then regenerate pnpm-lock.yaml.",
    ].join("\n"),
  );
  error.name = "ReactResolutionDriftError";
  throw error;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";

    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }

      reject(
        new Error(
          signal
            ? `${command} terminated by ${signal}`
            : `${command} exited with code ${code}`,
        ),
      );
    });
  });
}

async function copyValidationWorkspace(destination) {
  await Promise.all([
    ...[
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
    ].map((fileName) =>
      cp(join(workspaceRoot, fileName), join(destination, fileName)),
    ),
    cp(
      join(workspaceRoot, "artifacts/mockup-sandbox"),
      join(destination, "artifacts/mockup-sandbox"),
      {
        recursive: true,
        filter(source) {
          const relativePath = source.slice(workspaceRoot.length + 1);
          return ![
            "artifacts/mockup-sandbox/node_modules",
            "artifacts/mockup-sandbox/dist",
            "artifacts/mockup-sandbox/.tsbuildinfo",
          ].some(
            (excludedPath) =>
              relativePath === excludedPath ||
              relativePath.startsWith(`${excludedPath}/`),
          );
        },
      },
    ),
    cp(
      join(workspaceRoot, "vendor/image-size-secure"),
      join(destination, "vendor/image-size-secure"),
      { recursive: true },
    ),
  ]);
}

async function validateMockupFromCleanInstall() {
  const validationWorkspace = await mkdtemp(
    join(tmpdir(), "mockup-clean-typecheck-"),
  );

  try {
    console.log("Creating isolated mockup validation workspace...");
    await copyValidationWorkspace(validationWorkspace);

    console.log("Installing locked mockup dependencies from a clean state...");
    await run(
      "pnpm",
      [
        "--dir",
        validationWorkspace,
        "install",
        "--filter",
        "workspace",
        "--filter",
        "@workspace/mockup-sandbox",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prefer-offline",
      ],
      { cwd: workspaceRoot },
    );

    const listOutput = await run(
      "pnpm",
      [
        "--dir",
        validationWorkspace,
        "--filter",
        "@workspace/mockup-sandbox",
        "list",
        ...REACT_PACKAGES,
        "--depth",
        "Infinity",
        "--json",
      ],
      { cwd: workspaceRoot, capture: true },
    );
    const resolutions = inspectReactResolutions(JSON.parse(listOutput));
    assertStableReactResolutions(resolutions);
    console.log("Resolved one React dependency graph:");
    console.log(formatResolutionSummary(resolutions));

    console.log("Typechecking the clean mockup preview...");
    await run(
      "pnpm",
      [
        "--dir",
        validationWorkspace,
        "--filter",
        "@workspace/mockup-sandbox",
        "run",
        "typecheck",
      ],
      { cwd: workspaceRoot },
    );
    console.log("Clean mockup preview validation passed.");
  } finally {
    await rm(validationWorkspace, { recursive: true, force: true });
  }
}

const invokedAsScript =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  validateMockupFromCleanInstall().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
