import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  CAPTURED_EXPO_TOOLING,
  CAPTURED_LOADER_SAMPLES,
  fixtureOutput,
} from "./preview-startup-runtime-library-fixture.mjs";

const scriptsDirectory = import.meta.dirname;
const packageRoot = join(scriptsDirectory, "..");
const validatorPath = join(scriptsDirectory, "validate-preview-startup.mjs");
const fixturePath = join(
  scriptsDirectory,
  "preview-startup-runtime-library-fixture.mjs",
);
const refreshPath = join(
  scriptsDirectory,
  "refresh-preview-startup-runtime-library-fixture.mjs",
);
const packageRequire = createRequire(join(packageRoot, "package.json"));

function runNodeScript(args, env = {}) {
  const childEnvironment = { ...process.env, ...env };
  if (!Object.hasOwn(env, "GITHUB_STEP_SUMMARY")) {
    delete childEnvironment.GITHUB_STEP_SUMMARY;
  }
  if (!Object.hasOwn(env, "PREVIEW_STARTUP_LIVE_START_MARKER")) {
    delete childEnvironment.PREVIEW_STARTUP_LIVE_START_MARKER;
  }
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: childEnvironment,
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function findDiagnostic(output) {
  return output
    .split(/\r?\n/)
    .find((line) => line.startsWith("Expo preview startup error:"));
}

function containsControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installedPackageVersion(packageName) {
  const packageJsonPath = packageRequire.resolve(`${packageName}/package.json`);
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

function writeIndependentCaptureArtifacts(directory, suffix = "") {
  mkdirSync(directory, { recursive: true });
  for (const platform of ["linux", "macos", "windows"]) {
    const samples = Object.fromEntries(
      CAPTURED_LOADER_SAMPLES.filter(
        (sample) => sample.platform === platform,
      ).map((sample) => [
        sample.fixture,
        `${fixtureOutput[sample.fixture]}${suffix}${platform}\n`,
      ]),
    );
    writeFileSync(
      join(directory, `${platform}.json`),
      JSON.stringify(
        {
          platform,
          expoCli: installedPackageVersion("@expo/cli"),
          reactNative: installedPackageVersion("react-native"),
          samples,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
}

const capturedLoaderSampleNames = CAPTURED_LOADER_SAMPLES.map(
  ({ name }) => name,
).join(", ");

function capturedToolingVersionMismatch({
  displayName,
  packageName,
  capturedVersion,
}) {
  const installedVersion = installedPackageVersion(packageName);
  if (installedVersion === capturedVersion) {
    return null;
  }

  return (
    `${displayName} changed: loader samples were captured with ${capturedVersion}, ` +
      `but the installed version is ${installedVersion}. Affected captured loader ` +
      `samples: ${capturedLoaderSampleNames}. Refresh the captured samples in ` +
      "preview-startup-runtime-library-fixture.mjs and update the loader wording " +
      "parser in validate-preview-startup.mjs before relying on preview diagnostics."
  );
}

const fixtures = [
  {
    name: "Linux shared-library loader",
    fixture: "missing-runtime-library",
    detail: /shared libraries: libgtk-3\.so\.0: cannot open shared object file/,
    libraryIdentifier: "libgtk-3.so.0",
  },
  {
    name: "macOS dyld loader",
    fixture: "missing-runtime-library-dyld",
    detail: /Library not loaded: \/opt\/homebrew\/lib\/libgtk-3\.dylib/,
    libraryIdentifier: "libgtk-3.dylib",
  },
  {
    name: "Windows loader",
    fixture: "missing-runtime-library-windows",
    detail: /cannot proceed because libgtk-3-0\.dll was not found/,
    libraryIdentifier: "libgtk-3-0.dll",
  },
  {
    name: "Linux shared-library loader with a long path",
    fixture: "missing-runtime-library-long-path",
    detail: /missing runtime library: .*libgtk-3\.so\.0/,
    libraryIdentifier: "libgtk-3.so.0",
  },
  {
    name: "macOS dyld loader with a long path",
    fixture: "missing-runtime-library-dyld-long-path",
    detail: /missing runtime library: .*libgtk-3\.dylib/,
    libraryIdentifier: "libgtk-3.dylib",
  },
  {
    name: "Windows loader with a long path",
    fixture: "missing-runtime-library-windows-long-path",
    detail: /missing runtime library: .*libgtk-3-0\.dll/,
    libraryIdentifier: "libgtk-3-0.dll",
  },
  {
    name: "Linux shared-library loader with spaces",
    fixture: "missing-runtime-library-spaced",
    detail:
      /shared libraries: \/opt\/expo\/React Native DevTools\/libgtk-3\.so\.0/,
    libraryIdentifier: "libgtk-3.so.0",
    containsNoise: true,
  },
  {
    name: "macOS dyld loader with a quoted path",
    fixture: "missing-runtime-library-dyld-quoted",
    detail:
      /Library not loaded: '\/opt\/homebrew\/Library\/Application Support\/Expo\/libgtk-3\.dylib'/,
    libraryIdentifier: "libgtk-3.dylib",
    containsNoise: true,
  },
  {
    name: "Windows loader with a quoted path",
    fixture: "missing-runtime-library-windows-quoted",
    detail:
      /because "C:\\Program Files\\Expo\\React Native DevTools\\libgtk-3-0\.dll" was not found/,
    libraryIdentifier: "libgtk-3-0.dll",
    containsNoise: true,
  },
  {
    name: "macOS dyld loader with a quoted long path",
    fixture: "missing-runtime-library-dyld-quoted-long-path",
    detail: /missing runtime library: .*libgtk-3\.dylib/,
    libraryIdentifier: "libgtk-3.dylib",
  },
  {
    name: "Windows loader with a quoted long path",
    fixture: "missing-runtime-library-windows-quoted-long-path",
    detail: /missing runtime library: .*libgtk-3-0\.dll/,
    libraryIdentifier: "libgtk-3-0.dll",
  },
];

test("live and captured preview validation report the same diagnosis for every loader format", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-runtime-diagnostic-"),
  );

  try {
    for (const [index, fixtureCase] of fixtures.entries()) {
      const fixture = runNodeScript([fixturePath], {
        PREVIEW_STARTUP_TEST_FIXTURE: fixtureCase.fixture,
      });
      assert.equal(fixture.status, 1, fixtureCase.name);
      if (fixtureCase.fixture.includes("long-path")) {
        assert.ok(
          fixture.output.length > 384,
          `${fixtureCase.name} fixture did not cross the long-path boundary`,
        );
      }

      const capturedLogPath = join(
        temporaryDirectory,
        `expo-startup-${index}.log`,
      );
      writeFileSync(capturedLogPath, fixture.output, "utf8");

      const captured = runNodeScript([
        validatorPath,
        "--log-file",
        capturedLogPath,
      ]);
      const live = runNodeScript([validatorPath], {
        PREVIEW_STARTUP_TEST_FIXTURE: fixtureCase.fixture,
      });

      assert.notEqual(captured.status, 0, fixtureCase.name);
      assert.notEqual(live.status, 0, fixtureCase.name);

      const capturedDiagnostic = findDiagnostic(captured.output);
      const liveDiagnostic = findDiagnostic(live.output);
      assert.ok(capturedDiagnostic, fixtureCase.name);
      assert.equal(liveDiagnostic, capturedDiagnostic, fixtureCase.name);
      assert.match(capturedDiagnostic, fixtureCase.detail, fixtureCase.name);
      assert.match(
        capturedDiagnostic,
        new RegExp(fixtureCase.libraryIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${fixtureCase.name} lost its library identifier`,
      );
      assert.ok(
        capturedDiagnostic.length <= 512,
        `${fixtureCase.name} diagnostic exceeded the 512-character limit`,
      );
      if (fixtureCase.containsNoise) {
        assert.ok(
          !capturedDiagnostic.includes("unrelated log text") &&
            !containsControlCharacters(capturedDiagnostic),
          `${fixtureCase.name} included unrelated or control text`,
        );
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("real-platform capture records macOS and Windows loader output safely", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-real-platform-capture-"),
  );
  const cases = [
    {
      name: "macOS",
      fixture: "missing-runtime-library-dyld",
      output:
        "dyld[12345]: Library not loaded: /Users/reviewer/Library/" +
        "Application Support/Expo/react native devtools/libgtk-3.dylib\n" +
        "  Reason: Authorization: Bearer TOP_SECRET_VALUE\n",
      libraryIdentifier: "libgtk-3.dylib",
    },
    {
      name: "Windows",
      fixture: "missing-runtime-library-windows",
      output:
        "Error: The code execution cannot proceed because " +
        "C:\\Users\\reviewer\\AppData\\Local\\Expo\\libgtk-3-0.dll " +
        "was not found. password=TOP_SECRET_VALUE\n" +
        "Starting project at \\\\server\\share\\repo\\app --localhost --port 8081\n",
      libraryIdentifier: "libgtk-3-0.dll",
    },
    {
      name: "Windows host flag",
      fixture: "missing-runtime-library-windows",
      output:
        "Error: The code execution cannot proceed because " +
        "C:\\Users\\reviewer\\AppData\\Local\\Expo\\libgtk-3-0.dll " +
        "was not found. ******" +
        "Starting project at \\\\server\\share\\repo\\app --host tunnel\n",
      libraryIdentifier: "libgtk-3-0.dll",
      diagnosticPattern: /Expo preview loader wording changed/,
    },
    {
      name: "Windows drive startup args",
      fixture: "missing-runtime-library-windows",
      output:
        "Error: The code execution cannot proceed because " +
        "C:\\Users\\reviewer\\AppData\\Local\\Expo\\libgtk-3-0.dll " +
        "was not found. ******" +
        "Starting project at D:\\a\\RealtimeAlgoChatApp\\artifacts\\chat-app --host 0.0.0.0 --port 8081\n",
      libraryIdentifier: "libgtk-3-0.dll",
      diagnosticPattern: /Expo preview loader wording changed/,
    },
    {
      name: "Windows embedded host path text",
      fixture: "missing-runtime-library-windows",
      output:
        "Error: The code execution cannot proceed because " +
        "C:\\Users\\reviewer\\AppData\\Local\\Expo\\libgtk-3-0.dll " +
        "was not found. ******" +
        "Starting project at \\\\server\\share\\repo --host docs\\app --localhost --port 8081\n",
      libraryIdentifier: "libgtk-3-0.dll",
      diagnosticPattern: /Expo preview loader wording changed/,
      expectedRedactedProjectPath:
        String.raw`Starting project at \\[redacted]\repo --host docs\app`,
    },
    {
      name: "Windows UNC library path",
      fixture: "missing-runtime-library-windows",
      output:
        "Error: The code execution cannot proceed because " +
        "\\\\server\\share\\Expo\\libgtk-3-0.dll " +
        "was not found. ******" +
        "Starting project at \\\\server\\share\\repo\\app\n",
      libraryIdentifier: "libgtk-3-0.dll",
      diagnosticPattern: /Expo preview loader wording changed/,
    },
  ];

  try {
    for (const fixtureCase of cases) {
      const recordPath = join(
        temporaryDirectory,
        `${fixtureCase.name.toLowerCase()}.log`,
      );
      const live = runNodeScript(
        [validatorPath, "--record-log", recordPath],
        {
          PREVIEW_STARTUP_TEST_FIXTURE: fixtureCase.fixture,
          PREVIEW_STARTUP_TEST_OUTPUT: fixtureCase.output,
        },
      );

      assert.equal(live.status, 1, fixtureCase.name);
      const recordedOutput = readFileSync(recordPath, "utf8");
      assert.doesNotMatch(recordedOutput, /\/Users\/reviewer|C:\\Users\\reviewer/);
      assert.doesNotMatch(recordedOutput, /D:\\a\\RealtimeAlgoChatApp/);
      assert.doesNotMatch(recordedOutput, /\\\\server\\share\\Expo\\libgtk-3-0\.dll/);
      assert.doesNotMatch(
        recordedOutput,
        /\\\\server\\share\\repo\\app/,
      );
      assert.doesNotMatch(recordedOutput, /--localhost/);
      assert.doesNotMatch(recordedOutput, /--host tunnel/);
      assert.doesNotMatch(recordedOutput, /--port 8081/);
      assert.doesNotMatch(recordedOutput, /--host 0\.0\.0\.0/);
      assert.doesNotMatch(recordedOutput, /TOP_SECRET_VALUE/);
      assert.match(recordedOutput, new RegExp(fixtureCase.libraryIdentifier));
      if (fixtureCase.expectedRedactedProjectPath) {
        assert.match(
          recordedOutput,
          new RegExp(
            fixtureCase.expectedRedactedProjectPath
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          ),
        );
      }

      const captured = runNodeScript([
        validatorPath,
        "--log-file",
        recordPath,
      ]);
      assert.equal(captured.status, 1, fixtureCase.name);
      const liveDiagnostic = findDiagnostic(live.output);
      const capturedDiagnostic = findDiagnostic(captured.output);
      const diagnosticPattern =
        fixtureCase.diagnosticPattern ??
        new RegExp(fixtureCase.libraryIdentifier);
      assert.ok(liveDiagnostic, fixtureCase.name);
      assert.ok(capturedDiagnostic, fixtureCase.name);
      assert.match(liveDiagnostic, diagnosticPattern);
      assert.match(
        capturedDiagnostic,
        diagnosticPattern,
        fixtureCase.name,
      );
      assert.match(
        capturedDiagnostic,
        /Expo preview startup error:/,
        fixtureCase.name,
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("real launcher validation does not require a public preview URL", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-real-launcher-only-"),
  );
  const recordPath = join(temporaryDirectory, "launcher.log");

  try {
    const result = runNodeScript(
      [validatorPath, "--record-log", recordPath],
      {
        PREVIEW_STARTUP_REAL_LAUNCHER: "1",
        PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
        PREVIEW_STARTUP_TIMEOUT_MS: "2000",
      },
    );

    assert.equal(result.status, 0, result.output);
    assert.match(
      result.output,
      /Expo preview launcher reached Metro running status/,
    );
    assert.match(readFileSync(recordPath, "utf8"), /Starting Metro Bundler/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("startup test output override runs without preview URL configuration", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-startup-test-output-"),
  );
  const recordPath = join(temporaryDirectory, "startup.log");

  try {
    const result = runNodeScript(
      [validatorPath, "--record-log", recordPath],
      {
        PREVIEW_STARTUP_TEST_OUTPUT:
          'Error: The code execution cannot proceed because "C:\\Program Files\\Expo\\React Native DevTools\\libgtk-3-0.dll" was not found.\n',
      },
    );

    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Expo preview startup error:/);
    assert.match(readFileSync(recordPath, "utf8"), /libgtk-3-0\.dll/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test(
  "startup test output override skips preview URL configuration validation",
  () => {
    const result = runNodeScript([validatorPath, "--validate-configuration"], {
      PREVIEW_STARTUP_TEST_OUTPUT:
        'Error: The code execution cannot proceed because "C:\\Program Files\\Expo\\React Native DevTools\\libgtk-3-0.dll" was not found.\n',
    });

    assert.equal(result.status, 0, result.output);
    assert.equal(result.output, "");
  },
);

test(
  "Windows runner loader diagnosis keeps quoted spaced paths bounded",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const temporaryDirectory = mkdtempSync(
      join(process.env.RUNNER_TEMP ?? tmpdir(), "chat-preview-windows-runner-"),
    );
    const longPath =
      `C:\\Program Files\\Expo\\${"React Native DevTools cache\\".repeat(14)}` +
      "libgtk-3-0.dll";
    const cases = [
      {
        name: "quoted path with spaces",
        output:
          'Error: The code execution cannot proceed because "C:\\Program Files\\' +
          'Expo\\React Native DevTools\\libgtk-3-0.dll" was not found.\r\n' +
          "unrelated log text should not be included\r\n",
        detail:
          /because "C:\\Program Files\\Expo\\React Native DevTools\\libgtk-3-0\.dll" was not found/,
      },
      {
        name: "quoted long path with spaces",
        output:
          `Error: The code execution cannot proceed because "${longPath}" was not found.\r\n` +
          "unrelated log text should not be included\r\n",
        detail: /missing runtime library: .*libgtk-3-0\.dll/,
      },
    ];

    try {
      for (const [index, fixtureCase] of cases.entries()) {
        const recordPath = join(temporaryDirectory, `windows-${index}.log`);
        const realLauncherLive = runNodeScript(
          [validatorPath, "--record-log", recordPath],
          {
            PREVIEW_STARTUP_REAL_LAUNCHER: "1",
            PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library-windows",
            PREVIEW_STARTUP_TEST_OUTPUT: fixtureCase.output,
          },
        );
        const fixtureLive = runNodeScript([validatorPath], {
          PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library-windows",
          PREVIEW_STARTUP_TEST_OUTPUT: fixtureCase.output,
        });

        assert.ok(
          existsSync(recordPath),
          `${fixtureCase.name}; live validator output: ${JSON.stringify(realLauncherLive.output)}`,
        );
        assert.equal(realLauncherLive.status, 1, fixtureCase.name);
        assert.equal(fixtureLive.status, 1, fixtureCase.name);
        const captured = runNodeScript([
          validatorPath,
          "--log-file",
          recordPath,
        ]);
        assert.equal(captured.status, 1, fixtureCase.name);

        const fixtureDiagnostic = findDiagnostic(fixtureLive.output);
        const diagnostic = findDiagnostic(captured.output);
        assert.ok(diagnostic, fixtureCase.name);
        assert.ok(
          diagnostic,
          `${fixtureCase.name}; captured validator output: ${JSON.stringify(captured.output)}`,
        );
        assert.ok(fixtureDiagnostic, fixtureCase.name);
        assert.ok(
          diagnostic,
          `${fixtureCase.name}; captured validator output: ${JSON.stringify(captured.output)}`,
        );
        assert.ok(diagnostic, fixtureCase.name);
        assert.equal(fixtureDiagnostic, diagnostic, fixtureCase.name);
        assert.match(diagnostic, fixtureCase.detail, fixtureCase.name);
        assert.match(
          diagnostic,
          /libgtk-3-0\.dll/,
          `${fixtureCase.name} lost the DLL basename`,
        );
        assert.ok(
          diagnostic.length <= 512,
          `${fixtureCase.name} diagnostic exceeded the 512-character limit`,
        );
        assert.doesNotMatch(
          diagnostic,
          /unrelated log text/,
          `${fixtureCase.name} included unrelated log text`,
        );
        assert.equal(
          containsControlCharacters(diagnostic),
          false,
          `${fixtureCase.name} included control characters`,
        );
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
);

test("versioned loader samples match the installed Expo tooling", () => {
  const capturedExpoCliVersion =
    process.env.PREVIEW_STARTUP_TEST_CAPTURED_EXPO_CLI_VERSION ??
    CAPTURED_EXPO_TOOLING.expoCli;
  const capturedReactNativeVersion =
    process.env.PREVIEW_STARTUP_TEST_CAPTURED_REACT_NATIVE_VERSION ??
    CAPTURED_EXPO_TOOLING.reactNative;
  const mismatches = [
    capturedToolingVersionMismatch({
      displayName: "Expo CLI",
      packageName: "@expo/cli",
      capturedVersion: capturedExpoCliVersion,
    }),
    capturedToolingVersionMismatch({
      displayName: "React Native",
      packageName: "react-native",
      capturedVersion: capturedReactNativeVersion,
    }),
  ].filter(Boolean);
  if (mismatches.length > 0) {
    assert.fail(mismatches.join("\n"));
  }

  for (const { fixture: fixtureName } of CAPTURED_LOADER_SAMPLES) {
    const result = runNodeScript([fixturePath], {
      PREVIEW_STARTUP_TEST_FIXTURE: fixtureName,
    });
    assert.equal(result.status, 1, fixtureName);
    assert.doesNotMatch(
      result.output,
      /unsupported loader wording/i,
      fixtureName,
    );
  }
});

test("loader evidence includes every required platform and a captured output", () => {
  const requiredPlatforms = ["linux", "macos", "windows"];
  const platforms = new Set(
    CAPTURED_LOADER_SAMPLES.map(({ platform }) => platform),
  );
  assert.deepEqual(
    [...platforms].sort(),
    [...requiredPlatforms].sort(),
    "refresh evidence must include Linux, macOS, and Windows samples",
  );

  for (const sample of CAPTURED_LOADER_SAMPLES) {
    assert.equal(
      typeof fixtureOutput[sample.fixture],
      "string",
      `${sample.name} is missing captured loader output`,
    );
    assert.ok(
      fixtureOutput[sample.fixture].length > 0,
      `${sample.name} has empty captured loader output`,
    );
  }
});

test("refresh command updates tooling metadata, inventory, and outputs together", async () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-loader-refresh-"),
  );
  const captureDirectory = join(temporaryDirectory, "captures");
  const refreshedFixturePath = join(
    temporaryDirectory,
    "preview-startup-runtime-library-fixture.mjs",
  );

  try {
    writeIndependentCaptureArtifacts(captureDirectory, "independent-");
    const result = runNodeScript(
      [
        refreshPath,
        "--capture-dir",
        captureDirectory,
        "--output",
        refreshedFixturePath,
      ],
    );
    assert.equal(result.status, 0, result.output);

    const refreshedSource = readFileSync(refreshedFixturePath, "utf8");
    assert.match(
      refreshedSource,
      /BEGIN GENERATED PREVIEW LOADER EVIDENCE[\s\S]+END GENERATED PREVIEW LOADER EVIDENCE/,
    );
    assert.match(
      refreshedSource,
      /BEGIN GENERATED PREVIEW LOADER OUTPUT[\s\S]+END GENERATED PREVIEW LOADER OUTPUT/,
    );

    const refreshed = await import(
      `${pathToFileURL(refreshedFixturePath).href}?refresh-test`
    );
    assert.deepEqual(refreshed.CAPTURED_EXPO_TOOLING, {
      expoCli: installedPackageVersion("@expo/cli"),
      reactNative: installedPackageVersion("react-native"),
    });
    assert.deepEqual(
      refreshed.CAPTURED_LOADER_SAMPLES,
      CAPTURED_LOADER_SAMPLES,
    );
    for (const sample of refreshed.CAPTURED_LOADER_SAMPLES) {
      assert.equal(
        refreshed.fixtureOutput[sample.fixture],
        `${fixtureOutput[sample.fixture]}independent-${sample.platform}\n`,
        sample.name,
      );
      assert.notEqual(
        refreshed.fixtureOutput[sample.fixture],
        fixtureOutput[sample.fixture],
        `${sample.name} was not replaced by independent capture output`,
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("refresh command leaves the existing fixture untouched when a platform capture is missing", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-loader-refresh-incomplete-"),
  );
  const captureDirectory = join(temporaryDirectory, "captures");
  const outputPath = join(
    temporaryDirectory,
    "preview-startup-runtime-library-fixture.mjs",
  );
  const existingFixture = readFileSync(fixturePath, "utf8");

  try {
    mkdirSync(captureDirectory);
    const completeDirectory = join(temporaryDirectory, "complete");
    writeIndependentCaptureArtifacts(completeDirectory);
    for (const platform of ["linux", "macos"]) {
      const sourcePath = join(completeDirectory, `${platform}.json`);
      writeFileSync(
        join(captureDirectory, `${platform}.json`),
        readFileSync(sourcePath),
      );
    }
    writeFileSync(outputPath, existingFixture, "utf8");

    const result = runNodeScript([
      refreshPath,
      "--capture-dir",
      captureDirectory,
      "--output",
      outputPath,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.output, /Could not read windows capture/);
    assert.equal(readFileSync(outputPath, "utf8"), existingFixture);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test(
  "normal preview validation stops before live startup for stale tooling",
  { skip: Boolean(process.env.PREVIEW_STARTUP_TOOLING_MISMATCH) },
  () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "chat-preview-tooling-mismatch-"),
    );

    try {
      const scenarios = [
        {
          displayName: "Expo CLI",
          environmentName:
            "PREVIEW_STARTUP_TEST_CAPTURED_EXPO_CLI_VERSION",
          installedVersion: installedPackageVersion("@expo/cli"),
        },
        {
          displayName: "React Native",
          environmentName:
            "PREVIEW_STARTUP_TEST_CAPTURED_REACT_NATIVE_VERSION",
          installedVersion: installedPackageVersion("react-native"),
        },
      ];

      for (const scenario of scenarios) {
        const capturedVersion = "0.0.0";
        assert.notEqual(
          scenario.installedVersion,
          capturedVersion,
          `${scenario.displayName} fixture version must be stale`,
        );
        const markerPath = join(
          temporaryDirectory,
          `${scenario.displayName.toLowerCase().replaceAll(" ", "-")}.marker`,
        );
        const childEnvironment = {
          ...process.env,
          [scenario.environmentName]: capturedVersion,
          PREVIEW_STARTUP_TOOLING_MISMATCH: scenario.displayName,
          PREVIEW_STARTUP_LIVE_START_MARKER: markerPath,
          PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
        };
        delete childEnvironment.NODE_TEST_CONTEXT;
        const result = spawnSync(
          "pnpm",
          ["run", "validate:preview-startup"],
          {
            cwd: packageRoot,
            encoding: "utf8",
            env: childEnvironment,
            timeout: 60_000,
          },
        );
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

        assert.notEqual(
          result.error?.code,
          "ETIMEDOUT",
          `${scenario.displayName} mismatch validation did not terminate`,
        );
        assert.notEqual(result.status, 0, output);
        assert.match(
          output,
          new RegExp(
            `${scenario.displayName} changed: loader samples were captured with ` +
              escapeRegExp(capturedVersion),
          ),
        );
        assert.match(
          output,
          new RegExp(
            `but the installed version is ${escapeRegExp(
              scenario.installedVersion,
            )}`,
          ),
        );
        assert.match(output, /Affected captured loader samples:/);
        assert.match(output, /Linux shared-library loader/);
        assert.match(output, /Windows loader with a quoted long path/);
        assert.match(
          output,
          /preview-startup-runtime-library-fixture\.mjs/,
        );
        assert.match(output, /validate-preview-startup\.mjs/);
        assert.equal(
          existsSync(markerPath),
          false,
          `${scenario.displayName} mismatch continued into live preview startup`,
        );
        assert.equal(
          installedPackageVersion(
            scenario.displayName === "Expo CLI"
              ? "@expo/cli"
              : "react-native",
          ),
          scenario.installedVersion,
          `${scenario.displayName} mismatch test changed installed dependencies`,
        );
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
);

test("unsupported loader wording fails with a maintenance message", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-unsupported-loader-"),
  );
  const logPath = join(temporaryDirectory, "expo-startup.log");

  try {
    writeFileSync(logPath, fixtureOutput["unsupported-loader-wording"], "utf8");
    const result = runNodeScript([validatorPath, "--log-file", logPath]);

    assert.equal(result.status, 1);
    assert.match(result.output, /Expo preview loader wording changed/);
    assert.match(result.output, /refresh the versioned loader samples/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("malformed loader paths fail closed without leaking corrupted text", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-malformed-loader-"),
  );
  const malformedFixtures = [
    "missing-runtime-library-malformed-quotes",
    "missing-runtime-library-malformed-control",
    "missing-runtime-library-malformed-trailing",
    "missing-runtime-library-malformed-followed-by-valid",
  ];

  try {
    for (const [index, fixtureName] of malformedFixtures.entries()) {
      const fixture = runNodeScript([fixturePath], {
        PREVIEW_STARTUP_TEST_FIXTURE: fixtureName,
      });
      assert.equal(fixture.status, 1, fixtureName);

      const capturedLogPath = join(
        temporaryDirectory,
        `malformed-${index}.log`,
      );
      writeFileSync(capturedLogPath, fixture.output, "utf8");

      const live = runNodeScript([validatorPath], {
        PREVIEW_STARTUP_TEST_FIXTURE: fixtureName,
      });
      const captured = runNodeScript([
        validatorPath,
        "--log-file",
        capturedLogPath,
      ]);

      assert.equal(live.status, 1, fixtureName);
      assert.equal(captured.status, 1, fixtureName);
      const liveDiagnostic = findDiagnostic(live.output);
      const capturedDiagnostic = findDiagnostic(captured.output);
      assert.ok(liveDiagnostic, fixtureName);
      assert.equal(liveDiagnostic, capturedDiagnostic, fixtureName);
      assert.match(
        capturedDiagnostic,
        /Expo preview loader wording changed\. Update STARTUP_FAILURES and MISSING_LIBRARY_PATTERNS/,
        fixtureName,
      );
      assert.ok(
        capturedDiagnostic.length <= 512,
        `${fixtureName} diagnostic exceeded the 512-character limit`,
      );
      assert.doesNotMatch(
        capturedDiagnostic,
        /trailing unrelated loader text|libgtk-3\.(?:so\.0|dylib)|libgtk-3-0\.dll/i,
        `${fixtureName} leaked malformed loader content`,
      );
      assert.equal(
        containsControlCharacters(capturedDiagnostic),
        false,
        `${fixtureName} diagnostic contains control characters`,
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("fixture validation does not append to an inherited workflow summary", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-loader-summary-inheritance-"),
  );
  const summaryPath = join(temporaryDirectory, "summary.md");
  writeFileSync(summaryPath, "existing summary\n", "utf8");
  const inheritedSummary = process.env.GITHUB_STEP_SUMMARY;

  try {
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    const result = runNodeScript([validatorPath], {
      PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library",
    });

    assert.equal(result.status, 1, result.output);
    assert.equal(readFileSync(summaryPath, "utf8"), "existing summary\n");
  } finally {
    if (inheritedSummary === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = inheritedSummary;
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("startup failures append only the bounded diagnosis to the CI summary", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-startup-summary-"),
  );
  const summaryPath = join(temporaryDirectory, "summary.md");

  try {
    const result = runNodeScript([validatorPath], {
      GITHUB_STEP_SUMMARY: summaryPath,
      PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library",
    });

    assert.equal(result.status, 1);
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(summary, /^### Expo preview startup/m);
    assert.match(summary, /\*\*Status:\*\* FAIL/);
    assert.match(
      summary,
      /Expo preview startup error: Error: .*libgtk-3\.so\.0/,
    );
    assert.ok(summary.length <= 700, "summary exceeded its bounded size");
    assert.doesNotMatch(summary, /https?:\/\/|authorization|password|token/i);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CI summaries retain bounded long-path loader diagnostics and library identifiers", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-long-loader-summary-"),
  );
  const longPathFixtures = [
    {
      fixture: "missing-runtime-library-long-path",
      libraryIdentifier: "libgtk-3.so.0",
    },
    {
      fixture: "missing-runtime-library-dyld-long-path",
      libraryIdentifier: "libgtk-3.dylib",
    },
    {
      fixture: "missing-runtime-library-windows-long-path",
      libraryIdentifier: "libgtk-3-0.dll",
    },
  ];

  try {
    for (const { fixture: fixtureName } of longPathFixtures) {
      const logPath = join(temporaryDirectory, `${fixtureName}.log`);
      const summaryPath = join(temporaryDirectory, `${fixtureName}.md`);
      const unrelatedOutput =
        `unrelated loader output for ${fixtureName} should not leak`;
      writeFileSync(
        logPath,
        `${unrelatedOutput}\n${fixtureOutput[fixtureName]}${unrelatedOutput}\n`,
        "utf8",
      );

      const result = runNodeScript(
        [validatorPath, "--log-file", logPath],
        { GITHUB_STEP_SUMMARY: summaryPath },
      );

      assert.equal(result.status, 1, fixtureName);
      const summary = readFileSync(summaryPath, "utf8");
      const diagnostic = summary.match(/\*\*Diagnosis:\*\* ([^\n]+)/)?.[1];
      assert.ok(diagnostic, `${fixtureName} summary omitted its diagnosis`);
      assert.ok(
        diagnostic.length <= 512,
        `${fixtureName} summary diagnostic exceeded the 512-character limit`,
      );
      assert.match(
        diagnostic,
        /Expo preview startup error: .*missing runtime library: .*libgtk-3/,
        fixtureName,
      );
      assert.match(
        diagnostic,
        new RegExp(
          fixtureName.includes("dyld")
            ? "libgtk-3\\.dylib"
            : fixtureName.includes("windows")
              ? "libgtk-3-0\\.dll"
              : "libgtk-3\\.so\\.0",
        ),
        `${fixtureName} lost its library identifier`,
      );
      assert.doesNotMatch(summary, new RegExp(unrelatedOutput));
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CI summaries redact secrets from long loader diagnostics without losing library identifiers", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-long-private-loader-summary-"),
  );
  const longLinuxLibraryPath =
    `/opt/expo/${"react-native-devtools-cache/".repeat(16)}` +
    "libgtk-3.so.0";
  const longDyldLibraryPath =
    `/opt/homebrew/Library/Application Support/Expo/` +
    `${"react native devtools cache/".repeat(12)}` +
    "libgtk-3.dylib";
  const longWindowsLibraryPath =
    `C:\\Program Files\\Expo\\${"react native devtools cache\\".repeat(12)}` +
    "libgtk-3-0.dll";
  const cases = [
    {
      fixture: "missing-runtime-library",
      output:
        `Error: Authorization: Bearer LONG_LINUX_PRIVATE_TOKEN ` +
        `/opt/expo/react-native-devtools: error while loading shared libraries: ` +
        `${longLinuxLibraryPath}: cannot open shared object file: No such file or directory\n`,
      libraryIdentifier: "libgtk-3.so.0",
      privateValues: ["LONG_LINUX_PRIVATE_TOKEN"],
    },
    {
      fixture: "missing-runtime-library",
      output:
        `Error: Authorization: AWS4-HMAC-SHA256 ` +
        `Credential=LONG_AWS_ACCESS_KEY/20260918/us-east-1/expo/aws4_request, ` +
        `SignedHeaders=host;x-amz-date, Signature=VERY_SECRET_AWS_SIGNATURE ` +
        `/opt/expo/react-native-devtools: error while loading shared libraries: ` +
        `${longLinuxLibraryPath}: cannot open shared object file: No such file or directory\n`,
      libraryIdentifier: "libgtk-3.so.0",
      privateValues: ["LONG_AWS_ACCESS_KEY", "VERY_SECRET_AWS_SIGNATURE"],
    },
    {
      fixture: "missing-runtime-library-dyld",
      output:
        `dyld[12345]: Authorization: Bearer LONG_DYLD_PRIVATE_TOKEN; ` +
        `Library not loaded: ${longDyldLibraryPath}\n`,
      libraryIdentifier: "libgtk-3.dylib",
      privateValues: ["LONG_DYLD_PRIVATE_TOKEN"],
    },
    {
      fixture: "missing-runtime-library-dyld",
      output:
        `dyld[12345]: Proxy-Authorization: Digest ` +
        `username="preview-user", realm="private-preview", ` +
        `nonce="PRIVATE_NONCE", uri="/expo", ` +
        `response="VERY_SECRET_DIGEST_RESPONSE"; ` +
        `Library not loaded: ${longDyldLibraryPath}\n`,
      libraryIdentifier: "libgtk-3.dylib",
      privateValues: [
        "preview-user",
        "PRIVATE_NONCE",
        "VERY_SECRET_DIGEST_RESPONSE",
      ],
    },
    {
      fixture: "missing-runtime-library-windows",
      output:
        `Error: Authorization: Bearer LONG_WINDOWS_PRIVATE_TOKEN ` +
        `The code execution cannot proceed because ${longWindowsLibraryPath} ` +
        `was not found. Reinstalling the program may fix this problem.\n`,
      libraryIdentifier: "libgtk-3-0.dll",
      privateValues: ["LONG_WINDOWS_PRIVATE_TOKEN"],
    },
  ];

  try {
    for (const fixtureCase of cases) {
      const logPath = join(temporaryDirectory, `${fixtureCase.fixture}.log`);
      const summaryPath = join(temporaryDirectory, `${fixtureCase.fixture}.md`);
      const fixture = runNodeScript([fixturePath], {
        PREVIEW_STARTUP_TEST_FIXTURE: fixtureCase.fixture,
        PREVIEW_STARTUP_TEST_OUTPUT: fixtureCase.output,
      });

      assert.equal(fixture.status, 1, fixtureCase.fixture);
      assert.ok(
        fixture.output.length > 384,
        `${fixtureCase.fixture} fixture did not cross the long-path boundary`,
      );
      writeFileSync(logPath, fixture.output, "utf8");

      const result = runNodeScript(
        [validatorPath, "--log-file", logPath],
        { GITHUB_STEP_SUMMARY: summaryPath },
      );

      assert.equal(result.status, 1, fixtureCase.fixture);
      const summary = readFileSync(summaryPath, "utf8");
      const diagnostic = summary.match(/\*\*Diagnosis:\*\* ([^\n]+)/)?.[1];
      assert.ok(diagnostic, `${fixtureCase.fixture} summary omitted its diagnosis`);
      assert.ok(
        diagnostic.length <= 512,
        `${fixtureCase.fixture} summary diagnostic exceeded the 512-character limit`,
      );
      for (const privateValue of fixtureCase.privateValues) {
        assert.doesNotMatch(
          summary,
          new RegExp(escapeRegExp(privateValue)),
          `${fixtureCase.fixture} leaked ${privateValue}`,
        );
      }
      assert.match(
        diagnostic,
        new RegExp(escapeRegExp(fixtureCase.libraryIdentifier)),
        `${fixtureCase.fixture} lost its library identifier`,
      );
      assert.match(
        summary,
        /\[redacted authorization\]/,
        `${fixtureCase.fixture} omitted the authorization redaction`,
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CI summaries preserve direct preview-setting rejection reasons without values", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-setting-rejection-summary-"),
  );
  const cases = [
    {
      name: "malformed selected setting",
      value: "https://[preview-setting-secret",
      expectedReason:
        /Public Expo preview manifest URL configuration from PREVIEW_PUBLIC_URL is invalid/,
    },
    {
      name: "non-HTTPS selected setting",
      value: "http://preview-setting-secret.example.test/expo",
      expectedReason: /Public Expo preview manifest URL must use HTTPS/,
    },
    {
      name: "credential-bearing selected setting",
      value:
        "https://preview-user:preview-password@credential-preview.example.test/expo",
      expectedReason:
        /Public Expo preview manifest URL must not contain credentials/,
    },
  ];

  try {
    for (const [index, previewValue] of cases.entries()) {
      const summaryPath = join(
        temporaryDirectory,
        `summary-${index}.md`,
      );
      const result = runNodeScript([validatorPath], {
        GITHUB_STEP_SUMMARY: summaryPath,
        PREVIEW_PUBLIC_URL: previewValue.value,
        REPLIT_EXPO_DEV_DOMAIN: "fallback-preview.example.test",
        PREVIEW_PUBLIC_TIMEOUT_MS: "25",
        PREVIEW_STARTUP_TIMEOUT_MS: "2000",
        PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
      });

      assert.equal(result.status, 1, previewValue.name);
      const summary = readFileSync(summaryPath, "utf8");
      assert.match(summary, previewValue.expectedReason, previewValue.name);
      assert.ok(
        !summary.includes(previewValue.value),
        `${previewValue.name} leaked its configured value`,
      );
      if (previewValue.name === "malformed selected setting") {
        assert.doesNotMatch(
          summary,
          /https?:\/\/|authorization|proxy-authorization|password|passwd|secret|token/i,
          `${previewValue.name} leaked credential-like text`,
        );
      }
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("startup summaries redact private URLs and credentials from recognized failures", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-startup-private-summary-"),
  );

  try {
    const cases = [
      {
        header: "Authorization: Bearer",
        secret: "TOP_SECRET_VALUE",
      },
      {
        header: "Proxy-Authorization: Basic",
        secret: "PROXY_SECRET_VALUE",
      },
    ];

    for (const [index, { header, secret }] of cases.entries()) {
      const logPath = join(temporaryDirectory, `expo-startup-${index}.log`);
      const summaryPath = join(temporaryDirectory, `summary-${index}.md`);
      writeFileSync(
        logPath,
        `Error: react native devtools failed ${header} ${secret}\n`,
        "utf8",
      );

      const result = runNodeScript(
        [validatorPath, "--log-file", logPath],
        { GITHUB_STEP_SUMMARY: summaryPath },
      );

      assert.equal(result.status, 1, header);
      const summary = readFileSync(summaryPath, "utf8");
      assert.doesNotMatch(summary, new RegExp(secret), header);
      assert.match(summary, /\[redacted authorization\]/, header);
    }

    const urlLogPath = join(temporaryDirectory, "expo-startup-url.log");
    const urlSummaryPath = join(temporaryDirectory, "summary-url.md");
    writeFileSync(
      urlLogPath,
      "Error: react native devtools failed https://user:pass@private.example/path?token=secret password=private-password\n",
      "utf8",
    );
    const urlResult = runNodeScript(
      [validatorPath, "--log-file", urlLogPath],
      { GITHUB_STEP_SUMMARY: urlSummaryPath },
    );
    assert.equal(urlResult.status, 1);
    const urlSummary = readFileSync(urlSummaryPath, "utf8");
    assert.doesNotMatch(
      urlSummary,
      /private\.example|user:pass|private-password|secret/i,
    );
    assert.match(urlSummary, /\[redacted URL\]/);
    assert.match(urlSummary, /\[redacted credential\]/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("failing preflight-record validation does not append a startup summary", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-record-summary-"),
  );
  const recordPath = join(temporaryDirectory, "invalid-record.json");
  const summaryPath = join(temporaryDirectory, "summary.md");
  writeFileSync(recordPath, '{"invalid":true}\n', "utf8");
  writeFileSync(summaryPath, "existing summary\n", "utf8");

  try {
    const result = runNodeScript(
      [validatorPath, "--validate-record", recordPath],
      { GITHUB_STEP_SUMMARY: summaryPath },
    );

    assert.equal(result.status, 1);
    assert.equal(readFileSync(summaryPath, "utf8"), "existing summary\n");
    assert.doesNotMatch(result.output, /Expo preview startup\n/);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("healthy captured startup validation keeps the existing output and summary untouched", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-startup-healthy-"),
  );
  const logPath = join(temporaryDirectory, "expo-startup.log");
  const summaryPath = join(temporaryDirectory, "summary.md");
  writeFileSync(logPath, "Starting Metro Bundler\n", "utf8");
  writeFileSync(summaryPath, "existing summary\n", "utf8");

  try {
    const result = runNodeScript(
      [validatorPath, "--log-file", logPath],
      { GITHUB_STEP_SUMMARY: summaryPath },
    );

    assert.equal(result.status, 0);
    assert.match(result.output, /Expo preview startup output is healthy:/);
    assert.equal(readFileSync(summaryPath, "utf8"), "existing summary\n");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
