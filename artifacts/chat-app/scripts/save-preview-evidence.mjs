import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_SOURCE = path.join(
  PACKAGE_ROOT,
  ".expo",
  "dev-request-evidence.log",
);
const TIMESTAMP_DIRECTORY_PATTERN = /^\d{8}T\d{6}Z$/;
const SAFE_REQUEST_PATTERN =
  /^\[dev-request\] (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\d{3}) (\d+)ms platform=(ios|android|web|-) client=(preview-validation|Expo Go|curl|browser|other) user-agent=\[redacted\] resource=(manifest|bundle|asset|other)$/;
const SAFE_TRUNCATION_PATTERN =
  /^\[dev-request\] Evidence file truncated after \d+ request lines; console output continues\.$/;

const PLATFORM_CONFIG = {
  ios: {
    directoryName: "ios",
    label: "iOS",
    nativeFilename: "native-ios-request-evidence.txt",
  },
  android: {
    directoryName: "android",
    label: "Android",
    nativeFilename: "native-android-request-evidence.txt",
  },
};

function formatTimestampDirectory(date = new Date()) {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  if (argv[0] === "--") {
    argv = argv.slice(1);
  }

  let source;
  let timestamp;
  let handoffDir;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }

    if (argument === "--source") {
      source = requireArgument(argv, ++index, "--source");
    } else if (argument === "--timestamp") {
      timestamp = requireArgument(argv, ++index, "--timestamp");
    } else if (argument === "--handoff-dir") {
      handoffDir = requireArgument(argv, ++index, "--handoff-dir");
    } else {
      throw new Error(
        `Unknown argument "${argument}". Use --help for supported options.`,
      );
    }
  }

  if (timestamp && handoffDir) {
    throw new Error("Use either --timestamp or --handoff-dir, not both.");
  }

  return { handoffDir, source, timestamp };
}

function requireArgument(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function resolveSourcePath(configuredSource) {
  const source =
    configuredSource ||
    process.env.EXPO_DEV_REQUEST_EVIDENCE_FILE ||
    path.relative(PACKAGE_ROOT, DEFAULT_SOURCE);
  return path.resolve(PACKAGE_ROOT, source);
}

function resolveHandoffDirectory({ handoffDir, timestamp, platform }) {
  const config = PLATFORM_CONFIG[platform];
  const evidenceRoot = path.join(
    PACKAGE_ROOT,
    "test-results",
    "encrypted-room-recovery",
    config.directoryName,
  );
  const directory = handoffDir
    ? path.resolve(PACKAGE_ROOT, handoffDir)
    : path.join(evidenceRoot, timestamp || formatTimestampDirectory());

  if (
    path.dirname(directory) !== evidenceRoot ||
    !TIMESTAMP_DIRECTORY_PATTERN.test(path.basename(directory))
  ) {
    throw new Error(
      `The ${config.label} handoff directory must be a UTC timestamp directory directly under the repository ${config.directoryName} evidence directory.`,
    );
  }

  return directory;
}

function normalizeEvidenceLine(line, lineNumber) {
  if (SAFE_TRUNCATION_PATTERN.test(line)) {
    return { line, request: null };
  }

  const match = SAFE_REQUEST_PATTERN.exec(line);
  if (!match) {
    throw new Error(
      `The retained Metro evidence contains a non-redacted or unsupported line at line ${lineNumber}; refusing to copy it.`,
    );
  }

  const [, timestamp, method, status, duration, platform, client, resource] =
    match;
  return {
    line:
      `[dev-request] ${timestamp} ${method} ${status} ${duration}ms ` +
      `platform=${platform} client=${client} user-agent=[redacted] ` +
      `resource=${resource}`,
    request: { method, platform, client },
  };
}

function parseRetainedEvidence(contents, platform) {
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) {
    throw new Error("The retained Metro evidence file is empty.");
  }

  const normalizedLines = [];
  const nativeLines = [];
  for (const [index, line] of lines.entries()) {
    const normalized = normalizeEvidenceLine(line, index + 1);
    normalizedLines.push(normalized.line);
    if (
      normalized.request &&
      normalized.request.platform === platform &&
      normalized.request.client === "Expo Go" &&
      normalized.request.method !== "OPTIONS"
    ) {
      nativeLines.push(normalized.line);
    }
  }

  return { nativeLines, normalizedLines };
}

async function writeAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function savePreviewEvidence({
  packageRoot = PACKAGE_ROOT,
  platform,
  source,
  timestamp,
  handoffDir,
} = {}) {
  if (packageRoot !== PACKAGE_ROOT) {
    throw new Error("Changing the Chat App package root is not supported.");
  }
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    throw new Error("A supported preview platform is required.");
  }

  const sourcePath = resolveSourcePath(source);
  let contents;
  try {
    contents = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "The retained Metro evidence source is missing. Start Metro with EXPO_DEV_REQUEST_LOG=1, complete the preview session, and retry.",
      );
    }
    throw new Error(
      "The retained Metro evidence source could not be read; no evidence was saved.",
    );
  }

  const { nativeLines, normalizedLines } = parseRetainedEvidence(
    contents,
    platform,
  );
  const handoffDirectory = resolveHandoffDirectory({
    handoffDir,
    timestamp,
    platform,
  });
  const logsDirectory = path.join(handoffDirectory, "logs");
  const retainedPath = path.join(logsDirectory, "metro-request-evidence.txt");
  const nativePath = path.join(logsDirectory, config.nativeFilename);

  await mkdir(logsDirectory, { recursive: true });
  await writeAtomically(retainedPath, `${normalizedLines.join("\n")}\n`);
  await writeAtomically(
    nativePath,
    nativeLines.length > 0 ? `${nativeLines.join("\n")}\n` : "",
  );

  return {
    nativeRequestCount: nativeLines.length,
    nativePath,
    retainedPath,
  };
}

export async function runPreviewEvidenceCli(
  platform,
  argv = process.argv.slice(2),
) {
  const config = PLATFORM_CONFIG[platform];
  const options = parseArgs(argv);
  if (options.help) {
    printUsage(platform);
    return;
  }

  const result = await savePreviewEvidence({ ...options, platform });
  const relativePath = (filePath) => path.relative(process.cwd(), filePath);
  console.log(
    `Saved redacted Metro evidence: ${relativePath(result.retainedPath)}`,
  );
  console.log(
    `Saved filtered ${config.label} Expo Go evidence: ${relativePath(result.nativePath)}`,
  );
  console.log(`Filtered native request lines: ${result.nativeRequestCount}`);
}

function printUsage(platform) {
  const config = PLATFORM_CONFIG[platform];
  console.log(`Save redacted ${config.label} Expo Go preview request evidence.

Usage:
  pnpm run save:${platform}-preview-evidence -- [options]

Options:
  --source <path>        Retained Metro file; defaults to EXPO_DEV_REQUEST_EVIDENCE_FILE
                         or .expo/dev-request-evidence.log.
  --timestamp <UTC>      Create a ${config.label} handoff directory such as 20260916T120000Z.
  --handoff-dir <path>   Use an existing or new timestamp directory directly under
                         artifacts/chat-app/test-results/encrypted-room-recovery/${config.directoryName}/.
  --help                 Show this help.
`);
}
