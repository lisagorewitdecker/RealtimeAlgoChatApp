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
const baseEnvironment = {
  ...process.env,
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

try {
  const install = run("pnpm", ["exec", "playwright", "install", "chromium"]);
  if (install.status !== 0) {
    throw new Error(`Clean Chromium installation failed:\n${install.report}`);
  }

  const contract = run("node", [
    "e2e/check-playwright-runtime-contract.mjs",
  ]);
  if (contract.status !== 0) {
    throw new Error(
      `Chromium shared-library contract check failed:\n${contract.report}`,
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
    `Playwright checked Chromium's actual shared-library requirements, rejected removal of all ${requiredChromiumRuntimePackages.length} contracted native runtime packages, and launched it from a clean browser cache.`,
  );
} finally {
  rmSync(cleanDirectory, { recursive: true, force: true });
}