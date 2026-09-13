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

  const launch = run("node", ["e2e/check-playwright-runtime.mjs"]);
  if (launch.status !== 0) {
    throw new Error(`Clean Chromium launch failed:\n${launch.report}`);
  }

  const runtimeConfig = readFileSync(
    join(workspaceDirectory, ".replit"),
    "utf8",
  );
  writeFileSync(
    incompleteRuntimeConfig,
    runtimeConfig.replace('"nss", ', ""),
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
      'Required Chromium runtime package "nss" is missing',
    )
  ) {
    throw new Error(
      `Missing-library setup diagnostic did not match its contract:\n${missingLibrary.report}`,
    );
  }

  console.log(
    "Playwright installed and launched Chromium from a clean browser cache, and rejected an incomplete native runtime declaration.",
  );
} finally {
  rmSync(cleanDirectory, { recursive: true, force: true });
}