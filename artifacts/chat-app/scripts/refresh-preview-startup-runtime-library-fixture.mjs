import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPTURED_LOADER_SAMPLES,
} from "./preview-startup-runtime-library-fixture.mjs";

const scriptsDirectory = import.meta.dirname;
const packageRoot = join(scriptsDirectory, "..");
const fixturePath = join(
  scriptsDirectory,
  "preview-startup-runtime-library-fixture.mjs",
);
const packageRequire = createRequire(join(packageRoot, "package.json"));
const evidenceStartMarker = "// BEGIN GENERATED PREVIEW LOADER EVIDENCE";
const evidenceEndMarker = "// END GENERATED PREVIEW LOADER EVIDENCE";
const outputStartMarker = "// BEGIN GENERATED PREVIEW LOADER OUTPUT";
const outputEndMarker = "// END GENERATED PREVIEW LOADER OUTPUT";
const REQUIRED_LOADER_PLATFORMS = Object.freeze([
  "linux",
  "macos",
  "windows",
]);
const PRESERVED_FIXTURE_OUTPUTS = Object.freeze({
  "unsupported-loader-wording":
    "React Native DevTools launcher exited with status 127\n",
});

function installedPackageVersion(packageName) {
  const packageJsonPath = packageRequire.resolve(`${packageName}/package.json`);
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

function parseArguments(argv) {
  let outputPath = fixturePath;
  let captureDirectory;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--capture-dir") {
      const requestedPath = argv[index + 1];
      if (!requestedPath) {
        throw new Error("--capture-dir requires a directory path.");
      }
      captureDirectory = resolve(requestedPath);
      index += 1;
      continue;
    }
    if (argument === "--output") {
      const requestedPath = argv[index + 1];
      if (!requestedPath) {
        throw new Error("--output requires a fixture path.");
      }
      outputPath = resolve(requestedPath);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { captureDirectory, dryRun, outputPath };
}

function printHelp() {
  process.stdout.write(
    [
      "Refresh the versioned Expo preview loader evidence.",
      "",
      "Usage:",
      "  pnpm run refresh:preview-loader-evidence -- --capture-dir PATH",
      "  pnpm run refresh:preview-loader-evidence -- --capture-dir PATH --dry-run",
      "",
      "Each capture directory must contain linux.json, macos.json, and",
      "windows.json. Each file is independently produced on that platform",
      "with this shape:",
      '  { "platform": "linux", "expoCli": "...", "reactNative": "...",',
      '    "samples": { "fixture-name": "captured stderr..." } }',
      "",
      "The command reads the installed @expo/cli and react-native versions,",
      "validates every Linux, macOS, and Windows capture, and replaces the",
      "generated metadata, sample inventory, and output block together.",
      "No file is written unless all required platforms and samples are",
      "present and version-aligned. Use --output PATH for a temporary review copy.",
    ].join("\n") + "\n",
  );
}

function validateSampleInventory(samples) {
  const seenNames = new Set();
  const seenFixtures = new Set();
  const platforms = new Set();

  for (const sample of samples) {
    if (
      !sample ||
      typeof sample.name !== "string" ||
      typeof sample.platform !== "string" ||
      typeof sample.fixture !== "string" ||
      sample.name.length === 0 ||
      sample.fixture.length === 0
    ) {
      throw new Error("The loader sample inventory contains an invalid entry.");
    }
    if (seenNames.has(sample.name) || seenFixtures.has(sample.fixture)) {
      throw new Error(
        `The loader sample inventory contains a duplicate: ${sample.name}.`,
      );
    }
    seenNames.add(sample.name);
    seenFixtures.add(sample.fixture);
    platforms.add(sample.platform);
  }

  const missingPlatforms = REQUIRED_LOADER_PLATFORMS.filter(
    (platform) => !platforms.has(platform),
  );
  if (missingPlatforms.length > 0) {
    throw new Error(
      `Loader evidence is incomplete; missing platform samples: ${missingPlatforms.join(", ")}.`,
    );
  }
}

function readCaptureArtifacts(captureDirectory, tooling) {
  if (!captureDirectory) {
    throw new Error(
      "A capture directory is required; use --capture-dir with independent " +
        "Linux, macOS, and Windows capture artifacts.",
    );
  }

  const captures = new Map();
  for (const platform of REQUIRED_LOADER_PLATFORMS) {
    const capturePath = join(captureDirectory, `${platform}.json`);
    let capture;
    try {
      capture = JSON.parse(readFileSync(capturePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read ${platform} capture ${capturePath}: ${error.message}`,
      );
    }
    if (!capture || capture.platform !== platform) {
      throw new Error(
        `${capturePath} must identify the ${platform} capture platform.`,
      );
    }
    if (
      capture.expoCli !== tooling.expoCli ||
      capture.reactNative !== tooling.reactNative
    ) {
      throw new Error(
        `${capturePath} was captured with Expo CLI ${capture.expoCli ?? "unknown"} ` +
          `and React Native ${capture.reactNative ?? "unknown"}; installed ` +
          `versions are ${tooling.expoCli} and ${tooling.reactNative}.`,
      );
    }
    if (!capture.samples || typeof capture.samples !== "object") {
      throw new Error(`${capturePath} is missing its samples object.`);
    }
    const expectedFixtures = new Set(
      CAPTURED_LOADER_SAMPLES.filter(
        (sample) => sample.platform === platform,
      ).map((sample) => sample.fixture),
    );
    const actualFixtures = new Set(Object.keys(capture.samples));
    const missingFixtures = [...expectedFixtures].filter(
      (fixture) => !actualFixtures.has(fixture),
    );
    const unexpectedFixtures = [...actualFixtures].filter(
      (fixture) => !expectedFixtures.has(fixture),
    );
    if (missingFixtures.length > 0 || unexpectedFixtures.length > 0) {
      throw new Error(
        `${capturePath} sample inventory mismatch; missing: ` +
          `${missingFixtures.join(", ") || "none"}; unexpected: ` +
          `${unexpectedFixtures.join(", ") || "none"}.`,
      );
    }
    captures.set(platform, capture.samples);
  }
  return captures;
}

function replaceGeneratedBlock(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `The fixture is missing generated markers ${startMarker} / ${endMarker}.`,
    );
  }
  const endOfMarker = end + endMarker.length;
  return `${source.slice(0, start)}${replacement}${source.slice(endOfMarker)}`;
}

function formatEvidenceBlock(tooling, samples) {
  const toolingSource = JSON.stringify(tooling, null, 2);
  const samplesSource = samples
    .map((sample) => {
      const sampleSource = JSON.stringify(sample, null, 2)
        .split("\n")
        .map((line, index) => (index === 0 ? line : `  ${line}`))
        .join("\n");
      return `  Object.freeze(${sampleSource})`;
    })
    .join(",\n");
  return [
    evidenceStartMarker,
    `export const CAPTURED_EXPO_TOOLING = Object.freeze(${toolingSource});`,
    "",
    `export const REQUIRED_LOADER_PLATFORMS = Object.freeze(${JSON.stringify(
      REQUIRED_LOADER_PLATFORMS,
      null,
      2,
    )});`,
    "",
    "export const CAPTURED_LOADER_SAMPLES = Object.freeze([",
    samplesSource,
    "]);",
    evidenceEndMarker,
  ].join("\n");
}

function formatOutputBlock(outputs) {
  return [
    outputStartMarker,
    `export const fixtureOutput = Object.freeze(${JSON.stringify(
      outputs,
      null,
      2,
    )});`,
    outputEndMarker,
  ].join("\n");
}

function buildRefreshedFixture(captureDirectory) {
  validateSampleInventory(CAPTURED_LOADER_SAMPLES);

  const tooling = {
    expoCli: installedPackageVersion("@expo/cli"),
    reactNative: installedPackageVersion("react-native"),
  };
  const captures = readCaptureArtifacts(captureDirectory, tooling);
  const capturedOutputs = {};
  for (const sample of CAPTURED_LOADER_SAMPLES) {
    const output = captures.get(sample.platform)?.[sample.fixture];
    if (typeof output !== "string" || output.length === 0) {
      throw new Error(
        `The ${sample.platform} capture is missing ${sample.fixture}.`,
      );
    }
    capturedOutputs[sample.fixture] = output;
  }
  const outputs = { ...capturedOutputs, ...PRESERVED_FIXTURE_OUTPUTS };

  let refreshed = readFileSync(fixturePath, "utf8");
  refreshed = replaceGeneratedBlock(
    refreshed,
    evidenceStartMarker,
    evidenceEndMarker,
    formatEvidenceBlock(tooling, CAPTURED_LOADER_SAMPLES),
  );
  refreshed = replaceGeneratedBlock(
    refreshed,
    outputStartMarker,
    outputEndMarker,
    formatOutputBlock(outputs),
  );

  return {
    content: refreshed,
    sampleCount: CAPTURED_LOADER_SAMPLES.length,
    tooling,
    platforms: REQUIRED_LOADER_PLATFORMS,
  };
}

function writeAtomically(outputPath, content) {
  const outputDirectory = dirname(outputPath);
  const temporaryDirectory = mkdtempSync(
    join(outputDirectory, ".preview-loader-refresh-"),
  );
  const temporaryPath = join(temporaryDirectory, "fixture.mjs");

  try {
    writeFileSync(temporaryPath, content, "utf8");
    if (existsSync(outputPath)) {
      chmodSync(temporaryPath, statSync(outputPath).mode);
    }
    if (process.platform === "win32" && existsSync(outputPath)) {
      rmSync(outputPath);
    }
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const refreshed = buildRefreshedFixture(options.captureDirectory);
  if (!options.dryRun) {
    writeAtomically(options.outputPath, refreshed.content);
  }

  const destination = options.dryRun ? " (dry run; no file written)" : "";
  process.stdout.write(
    `Refreshed ${refreshed.sampleCount} preview loader samples for ` +
      `${refreshed.platforms.join(", ")} using Expo CLI ${refreshed.tooling.expoCli} ` +
      `and React Native ${refreshed.tooling.reactNative}${destination}.\n`,
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Preview loader evidence refresh failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
