import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(scriptDirectory, "..");
const workspaceRoot = join(appRoot, "../..");
const packageRequire = createRequire(join(appRoot, "package.json"));

const requiredNixPackages = [
  "glib",
  "nss",
  "nspr",
  "atk",
  "at-spi2-atk",
  "dbus",
  "xorg.libX11",
  "xorg.libXcomposite",
  "xorg.libXdamage",
  "xorg.libXext",
  "xorg.libXfixes",
  "xorg.libXrandr",
  "mesa",
  "xorg.libxcb",
  "libxkbcommon",
  "alsa-lib",
  "at-spi2-core",
  "libgbm",
  "cups",
  "expat",
  "libdrm",
  "pango",
  "cairo",
  "fontconfig",
  "freetype",
  "systemd",
  "gtk3",
];

function packageVersion(packageName) {
  return JSON.parse(
    readFileSync(packageRequire.resolve(`${packageName}/package.json`), "utf8"),
  ).version;
}

function readNixPackages() {
  const replitConfig = readFileSync(join(workspaceRoot, ".replit"), "utf8");
  const match = replitConfig.match(
    /^\s*packages\s*=\s*\[(?<packages>[^\]]*)\]/m,
  );
  if (!match?.groups?.packages) {
    throw new Error("Could not find the [nix].packages list in .replit.");
  }

  return [
    ...match.groups.packages.matchAll(/"(?<package>[^"]+)"/g),
  ].map(({ groups }) => groups.package);
}

function readCapturedTooling() {
  const fixture = readFileSync(
    join(appRoot, "scripts/preview-startup-runtime-library-fixture.mjs"),
    "utf8",
  );
  const expoCli = fixture.match(/"expoCli":\s*"([^"]+)"/)?.[1];
  const reactNative = fixture.match(/"reactNative":\s*"([^"]+)"/)?.[1];
  if (!expoCli || !reactNative) {
    throw new Error(
      "Could not read captured Expo CLI and React Native versions from the loader fixture.",
    );
  }
  return { expoCli, reactNative };
}

function checkExpoPackageCompatibility() {
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    pnpmCommand,
    ["exec", "expo", "install", "--check"],
    {
      cwd: appRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    },
  );
  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  throw new Error(
    "Expo SDK package compatibility check failed. " +
      (output || `pnpm exec expo install --check exited with ${result.status}`),
  );
}

checkExpoPackageCompatibility();

const configuredNixPackages = new Set(readNixPackages());
const missingNixPackages = requiredNixPackages.filter(
  (packageName) => !configuredNixPackages.has(packageName),
);
const installedTooling = {
  expoCli: packageVersion("@expo/cli"),
  reactNative: packageVersion("react-native"),
};
const capturedTooling = readCapturedTooling();
const toolingMismatches = Object.entries(installedTooling)
  .filter(([name, version]) => version !== capturedTooling[name])
  .map(
    ([name, version]) =>
      `${name} captured=${capturedTooling[name]} installed=${version}`,
  );

if (missingNixPackages.length > 0 || toolingMismatches.length > 0) {
  const problems = [];
  if (missingNixPackages.length > 0) {
    problems.push(
      `missing [nix].packages entries: ${missingNixPackages.join(", ")}`,
    );
  }
  if (toolingMismatches.length > 0) {
    problems.push(
      `captured loader tooling is stale: ${toolingMismatches.join("; ")}`,
    );
  }
  throw new Error(
    `${problems.join(". ")}. Review the preview runtime dependency procedure ` +
      "before starting Metro.",
  );
}

console.log(
  `Expo preview runtime is aligned: @expo/cli ${installedTooling.expoCli}, ` +
    `react-native ${installedTooling.reactNative}, ` +
    `${requiredNixPackages.length} required Nix packages present.`,
);