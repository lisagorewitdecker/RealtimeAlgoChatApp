// Expo Go compatibility for packages whose JavaScript talks to native code that
// is compiled into the Expo Go binary itself (react-native-worklets and
// react-native-reanimated). Expo Go cannot load a different native version, so
// the installed JavaScript must match the build this app is loaded with, even
// when that differs from the SDK default in expo/bundledNativeModules.json.
//
// Why a dedicated check: worklets validates only major.minor at startup, so a
// patch mismatch is never reported. Expo Go iOS 57.0.5 (Replit's iPhone
// simulator) embeds worklets 0.10.0, whose createSerializableNonWorkletFunction
// binding takes three arguments; the 0.10.1 JavaScript that SDK 57 recommends
// calls it with two, and the native side dereferences the missing argument.
// The app dies during bundle evaluation with no red box and no client log.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const appRoot = join(scriptDirectory, "..");
export const recordPath = join(appRoot, "expo-go-native-modules.json");

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function parseVersion(version) {
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
    return undefined;
  }
  return version.split(".").map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function resolveExpoGoBuild(record) {
  const target = parseVersion(record?.targetExpoGoIosVersion);
  if (!target) {
    throw new Error(
      "expo-go-native-modules.json needs targetExpoGoIosVersion as an exact " +
        "x.y.z Expo Go iOS version.",
    );
  }
  const builds = record.expoGoIosBuilds ?? {};
  let best;
  for (const [version, nativeModules] of Object.entries(builds)) {
    const parsed = parseVersion(version);
    if (!parsed) {
      throw new Error(
        `expo-go-native-modules.json lists build "${version}", which is not an exact x.y.z version.`,
      );
    }
    if (compareVersions(parsed, target) > 0) {
      continue;
    }
    if (!best || compareVersions(parsed, best.parsed) > 0) {
      best = { version, parsed, nativeModules };
    }
  }
  if (!best) {
    throw new Error(
      `expo-go-native-modules.json has no build at or below the targeted Expo Go iOS ${record.targetExpoGoIosVersion}; add the versions that build embeds before targeting it.`,
    );
  }
  const modules = Object.entries(best.nativeModules ?? {});
  if (modules.length === 0) {
    throw new Error(
      `expo-go-native-modules.json build ${best.version} lists no native modules.`,
    );
  }
  for (const [packageName, version] of modules) {
    if (!parseVersion(version)) {
      throw new Error(
        `expo-go-native-modules.json build ${best.version} pins ${packageName} to "${version}", which is not an exact x.y.z version.`,
      );
    }
  }
  return { targetVersion: record.targetExpoGoIosVersion, build: best.version, nativeModules: best.nativeModules };
}

function declaredSpecifier(packageJson, packageName) {
  return (
    packageJson.dependencies?.[packageName] ??
    packageJson.devDependencies?.[packageName]
  );
}

/**
 * Compares the installed JavaScript versions with the native modules inside
 * the targeted Expo Go build. Pure: every input is passed in so tests can
 * exercise each failure without touching node_modules.
 */
export function checkExpoGoNativeCompatibility({
  record,
  packageJson,
  bundledNativeModules,
  installedVersions,
}) {
  const { targetVersion, build, nativeModules } = resolveExpoGoBuild(record);
  const problems = [];
  const deviatingPackages = [];

  for (const [packageName, embeddedVersion] of Object.entries(nativeModules)) {
    const installed = installedVersions[packageName];
    const declared = declaredSpecifier(packageJson, packageName);
    const sdkDefault = bundledNativeModules[packageName];

    if (installed !== embeddedVersion) {
      problems.push(
        `${packageName} installed=${installed ?? "missing"} but Expo Go iOS ${targetVersion} ` +
          `(targeted build ${build} in expo-go-native-modules.json) embeds ${embeddedVersion}. ` +
          "Expo Go quits during startup on such a mismatch without a red box or client log. " +
          `Install exactly ${embeddedVersion}, or retarget targetExpoGoIosVersion when the simulator's Expo Go build changes.`,
      );
    }
    if (declared !== embeddedVersion) {
      problems.push(
        `${packageName} is declared as "${declared ?? "missing"}" in package.json; declare the exact ` +
          `version ${embeddedVersion} so a range cannot drift away from the Expo Go native part.`,
      );
    }
    if (sdkDefault === undefined) {
      problems.push(
        `${packageName} is missing from expo/bundledNativeModules.json; the installed Expo SDK does not manage it, so remove it from expo-go-native-modules.json or check the SDK upgrade.`,
      );
    } else if (sdkDefault !== embeddedVersion) {
      deviatingPackages.push(packageName);
    }
  }

  const excluded = Array.isArray(packageJson.expo?.install?.exclude)
    ? packageJson.expo.install.exclude
    : [];
  const expectedExcludes = [...deviatingPackages].sort();
  const actualExcludes = [...excluded].sort();
  if (JSON.stringify(expectedExcludes) !== JSON.stringify(actualExcludes)) {
    problems.push(
      `expo.install.exclude in package.json is [${actualExcludes.join(", ")}] but must list exactly the ` +
        `packages whose Expo Go ${targetVersion} version differs from the SDK default: [${expectedExcludes.join(", ")}]. ` +
        "The exclusion keeps `expo install --check` honest about the intentional pin and must go away once the pin is no longer needed.",
    );
  }

  const summary =
    `Expo Go iOS ${targetVersion} native modules (build ${build}): ` +
    Object.entries(nativeModules)
      .map(([packageName, version]) => {
        const sdkDefault = bundledNativeModules[packageName];
        const note =
          sdkDefault !== undefined && sdkDefault !== version
            ? ` (SDK default ${sdkDefault}, excluded from expo install --check)`
            : "";
        return `${packageName} ${version}${note}`;
      })
      .join(", ");

  return { problems, summary, targetVersion, build, nativeModules, deviatingPackages };
}

export function readRecord(path = recordPath) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readInstalledInputs(root = appRoot) {
  const packageRequire = createRequire(join(root, "package.json"));
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const bundledNativeModules = JSON.parse(
    readFileSync(packageRequire.resolve("expo/bundledNativeModules.json"), "utf8"),
  );
  const record = readRecord(join(root, "expo-go-native-modules.json"));
  const installedVersions = {};
  const { nativeModules } = resolveExpoGoBuild(record);
  for (const packageName of Object.keys(nativeModules)) {
    try {
      installedVersions[packageName] = JSON.parse(
        readFileSync(packageRequire.resolve(`${packageName}/package.json`), "utf8"),
      ).version;
    } catch {
      installedVersions[packageName] = undefined;
    }
  }
  return { record, packageJson, bundledNativeModules, installedVersions };
}

export function validateExpoGoNativeCompatibility(root = appRoot) {
  const result = checkExpoGoNativeCompatibility(readInstalledInputs(root));
  if (result.problems.length > 0) {
    throw new Error(
      `Expo Go native module compatibility check failed:\n- ${result.problems.join("\n- ")}`,
    );
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(validateExpoGoNativeCompatibility().summary);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
