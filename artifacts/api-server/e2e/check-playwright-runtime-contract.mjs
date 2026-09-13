import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { chromium } from "@playwright/test";
import {
  chromiumLibraryNixPackages,
  chromiumSystemLibraries,
} from "./playwright-runtime-packages.mjs";

const runtimeConfigPath =
  process.env.PLAYWRIGHT_RUNTIME_CONFIG_PATH ??
  new URL("../../../.replit", import.meta.url);
const chromiumRoot = dirname(dirname(chromium.executablePath()));
const chromiumRevision = basename(chromiumRoot).match(/^chromium-(.+)$/)?.[1];
if (!chromiumRevision) {
  throw new Error(
    `Could not determine Chromium's Playwright revision from ${chromiumRoot}.`,
  );
}
const browserRoots = [
  chromiumRoot,
  join(dirname(chromiumRoot), `chromium_headless_shell-${chromiumRevision}`),
];
for (const browserRoot of browserRoots) {
  if (!existsSync(browserRoot)) {
    throw new Error(
      `Playwright browser artifact ${browserRoot} is not installed. Run "playwright install chromium" and retry.`,
    );
  }
}

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

function* filesBelow(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* filesBelow(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function neededLibraries(path) {
  const result = spawnSync("readelf", ["-d", path], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    return [];
  }
  return [...result.stdout.matchAll(/Shared library: \[([^\]]+)\]/g)].map(
    ([, library]) => library,
  );
}

const libraries = new Set(
  browserRoots.flatMap((browserRoot) =>
    [...filesBelow(browserRoot)].flatMap((path) => neededLibraries(path)),
  ),
);
if (libraries.size === 0) {
  throw new Error(
    `No ELF shared-library requirements were found below ${browserRoots.join(", ")}; Chromium may not be installed or readelf may be incompatible.`,
  );
}

const declaredPackages = readDeclaredNixPackages(
  readFileSync(runtimeConfigPath, "utf8"),
);
const unknownLibraries = [];
const missingPackages = new Map();

for (const library of [...libraries].sort()) {
  if (chromiumSystemLibraries.some((pattern) => pattern.test(library))) {
    continue;
  }
  const packageName = [...chromiumLibraryNixPackages].find(([pattern]) =>
    pattern.test(library),
  )?.[1];
  if (!packageName) {
    unknownLibraries.push(library);
  } else if (!declaredPackages.has(packageName)) {
    const packageLibraries = missingPackages.get(packageName) ?? [];
    packageLibraries.push(library);
    missingPackages.set(packageName, packageLibraries);
  }
}

if (unknownLibraries.length > 0 || missingPackages.size > 0) {
  const guidance = [
    "Chromium's native shared-library requirements are not fully covered by the Replit Nix contract.",
  ];
  if (unknownLibraries.length > 0) {
    guidance.push(
      `Unknown Chromium libraries: ${unknownLibraries.join(", ")}.`,
      "Find the Replit-compatible nixpkgs attribute that provides each library, then add its SONAME mapping to e2e/playwright-runtime-packages.mjs.",
    );
  }
  for (const [packageName, packageLibraries] of missingPackages) {
    guidance.push(
      `Missing Replit Nix package "${packageName}" for ${packageLibraries.join(", ")}.`,
    );
  }
  guidance.push(
    `Add missing package names to [nix].packages in ${runtimeConfigPath} and requiredChromiumRuntimePackages, then run test:browser:clean-runtime again.`,
  );
  throw new Error(guidance.join("\n"));
}

console.log(
  `Chromium revision ${chromiumRevision}'s ${libraries.size} direct ELF shared-library requirements across desktop Chromium and Headless Shell are covered by the Replit Nix contract.`,
);