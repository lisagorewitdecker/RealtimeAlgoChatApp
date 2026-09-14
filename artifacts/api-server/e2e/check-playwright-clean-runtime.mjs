import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredChromiumRuntimePackages } from "./playwright-runtime-packages.mjs";

const apiServerDirectory = fileURLToPath(new URL("..", import.meta.url));
const workspaceDirectory = fileURLToPath(new URL("../../..", import.meta.url));
const cleanDirectory = mkdtempSync(
  join(tmpdir(), "api-playwright-clean-runtime-"),
);
const browserDirectory = join(cleanDirectory, "browsers");
const incompleteRuntimeConfig = join(cleanDirectory, ".replit");
// Test-only controls of the runtime contract check. Ordinary subprocesses must
// never inherit them from this process, so each fixture below adds exactly the
// capability it exercises.
const contractTestModeVariable = "PLAYWRIGHT_RUNTIME_CONTRACT_TEST_MODE";
const contractInjectLibraryVariable =
  "PLAYWRIGHT_RUNTIME_CONTRACT_INJECT_LIBRARY";
const baseEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== contractTestModeVariable &&
        name !== contractInjectLibraryVariable,
    ),
  ),
  PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
};

function run(command, args, environment = baseEnvironment) {
  const result = spawnSync(command, args, {
    cwd: apiServerDirectory,
    encoding: "utf8",
    env: environment,
    stdio: "pipe",
    timeout: 180_000,
  });
  const report = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    throw result.error;
  }
  return { ...result, report };
}

// The contract check reports how many ELF shared-library requirements it
// covered. A fixture that leaks into a normal run would change this count.
function coveredLibraryCount(report) {
  const count = report.match(
    /'s (\d+) direct ELF shared-library requirements across desktop Chromium and Headless Shell are covered by the Replit Nix contract\./,
  )?.[1];
  return count === undefined ? undefined : Number(count);
}

try {
  const install = run("pnpm", ["exec", "playwright", "install", "chromium"]);
  if (install.status !== 0) {
    throw new Error(`Clean Chromium installation failed:\n${install.report}`);
  }

  const contract = run("node", [
    "e2e/check-playwright-runtime-contract.mjs",
  ]);
  const contractLibraryCount = coveredLibraryCount(contract.report);
  if (contract.status !== 0 || contractLibraryCount === undefined) {
    throw new Error(
      `Chromium shared-library contract check failed:\n${contract.report}`,
    );
  }

  // The injection variable alone must stay inert: an inherited value without
  // the explicit test-mode capability cannot add a library to a normal check.
  const syntheticUnknownLibrary = "libsynthetic-playwright-upgrade.so.99";
  const inheritedInjection = run(
    "node",
    ["e2e/check-playwright-runtime-contract.mjs"],
    {
      ...baseEnvironment,
      [contractInjectLibraryVariable]: syntheticUnknownLibrary,
    },
  );
  if (
    inheritedInjection.status !== 0 ||
    inheritedInjection.report.includes(syntheticUnknownLibrary) ||
    coveredLibraryCount(inheritedInjection.report) !== contractLibraryCount
  ) {
    throw new Error(
      `${contractInjectLibraryVariable} without ${contractTestModeVariable} was not inert (expected the normal contract check to pass and cover exactly ${contractLibraryCount} libraries):\n${inheritedInjection.report}`,
    );
  }

  const unknownLibrary = run(
    "node",
    ["e2e/check-playwright-runtime-contract.mjs"],
    {
      ...baseEnvironment,
      [contractTestModeVariable]: "1",
      [contractInjectLibraryVariable]: syntheticUnknownLibrary,
    },
  );
  if (
    unknownLibrary.status !== 1 ||
    !unknownLibrary.report.includes(
      `Unknown Chromium libraries: ${syntheticUnknownLibrary}.`,
    ) ||
    !unknownLibrary.report.includes(
      "Find the Replit-compatible nixpkgs attribute that provides each library",
    ) ||
    !unknownLibrary.report.includes(
      "add its SONAME mapping to e2e/playwright-runtime-packages.mjs",
    )
  ) {
    throw new Error(
      `Unknown-library upgrade diagnostic did not match its contract:\n${unknownLibrary.report}`,
    );
  }

  const runtimeConfig = readFileSync(
    join(workspaceDirectory, ".replit"),
    "utf8",
  );
  for (const packageName of requiredChromiumRuntimePackages) {
    const packageEntry = `"${packageName}"`;
    if (!runtimeConfig.includes(packageEntry)) {
      throw new Error(
        `Chromium runtime contract package ${packageEntry} is not declared in .replit.`,
      );
    }
    writeFileSync(
      incompleteRuntimeConfig,
      runtimeConfig.replace(packageEntry, `"fixture-removed-${packageName}"`),
    );
    const missingLibrary = run(
      "node",
      ["e2e/check-playwright-runtime.mjs"],
      {
        ...baseEnvironment,
        PLAYWRIGHT_RUNTIME_CONFIG_PATH: incompleteRuntimeConfig,
      },
    );
    if (
      missingLibrary.status !== 1 ||
      !missingLibrary.report.includes("[api-server browser setup]") ||
      !missingLibrary.report.includes("Chromium is not ready for API tests") ||
      !missingLibrary.report.includes(
        `Required Chromium runtime package "${packageName}" is missing`,
      )
    ) {
      throw new Error(
        `Missing-library setup diagnostic for ${packageEntry} did not match its contract:\n${missingLibrary.report}`,
      );
    }
  }

  const launch = run("node", ["e2e/check-playwright-runtime.mjs"]);
  if (launch.status !== 0) {
    throw new Error(`Clean Chromium launch failed:\n${launch.report}`);
  }

  console.log(
    `Playwright checked Chromium's actual shared-library requirements, ignored an inherited synthetic SONAME injection without test mode, rejected that unknown SONAME under test mode and removal of all ${requiredChromiumRuntimePackages.length} contracted native runtime packages, and launched it from a clean browser cache.`,
  );
} finally {
  rmSync(cleanDirectory, { recursive: true, force: true });
}