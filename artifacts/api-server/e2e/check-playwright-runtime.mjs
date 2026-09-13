import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { requiredChromiumRuntimePackages } from "./playwright-runtime-packages.mjs";

const setupMessage =
  "Chromium is not ready for API tests. Run the test command from a Replit environment with the Chromium runtime packages declared in .replit, then retry.";
const runtimeConfigPath =
  process.env.PLAYWRIGHT_RUNTIME_CONFIG_PATH ??
  fileURLToPath(new URL("../../../.replit", import.meta.url));

function readDeclaredNixPackages(runtimeConfig) {
  const nixSection = runtimeConfig.match(
    /(?:^|\n)\[nix\]\s*\n([\s\S]*?)(?=\n\[|$)/,
  )?.[1];
  const packageDeclaration = nixSection?.match(
    /(?:^|\n)\s*packages\s*=\s*\[([\s\S]*?)\]/,
  )?.[1];

  return new Set(
    [...(packageDeclaration?.matchAll(/"([^"]+)"/g) ?? [])].map(
      ([, packageName]) => packageName,
    ),
  );
}

let browser;
try {
  const runtimeConfig = await readFile(runtimeConfigPath, "utf8");
  const declaredNixPackages = readDeclaredNixPackages(runtimeConfig);
  for (const packageName of requiredChromiumRuntimePackages) {
    if (!declaredNixPackages.has(packageName)) {
      throw new Error(
        `Required Chromium runtime package "${packageName}" is missing from ${runtimeConfigPath}.`,
      );
    }
  }
  browser = await chromium.launch({ headless: true });
} catch (error) {
  console.error(`[api-server browser setup] ${setupMessage}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
}