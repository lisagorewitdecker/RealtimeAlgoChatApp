import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAPTURED_EXPO_TOOLING,
  fixtureOutput,
} from "./preview-startup-runtime-library-fixture.mjs";

const scriptsDirectory = import.meta.dirname;
const packageRoot = join(scriptsDirectory, "..");
const validatorPath = join(scriptsDirectory, "validate-preview-startup.mjs");
const fixturePath = join(
  scriptsDirectory,
  "preview-startup-runtime-library-fixture.mjs",
);
const packageRequire = createRequire(join(packageRoot, "package.json"));

function runNodeScript(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
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

function installedPackageVersion(packageName) {
  const packageJsonPath = packageRequire.resolve(`${packageName}/package.json`);
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
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
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("versioned loader samples match the installed Expo tooling", () => {
  assert.equal(
    installedPackageVersion("@expo/cli"),
    CAPTURED_EXPO_TOOLING.expoCli,
    "Expo CLI changed; refresh the versioned loader samples and update the " +
      "loader wording parser before relying on preview diagnostics.",
  );
  assert.equal(
    installedPackageVersion("react-native"),
    CAPTURED_EXPO_TOOLING.reactNative,
    "React Native changed; refresh the versioned loader samples and update the " +
      "loader wording parser before relying on preview diagnostics.",
  );

  for (const fixtureName of [
    "missing-runtime-library",
    "missing-runtime-library-dyld",
    "missing-runtime-library-windows",
  ]) {
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

test("CI summaries name the malformed selected preview setting without its value", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-malformed-setting-summary-"),
  );
  const summaryPath = join(temporaryDirectory, "summary.md");
  const malformedValue = "https://[preview-setting-secret";

  try {
    const result = runNodeScript([validatorPath], {
      GITHUB_STEP_SUMMARY: summaryPath,
      PREVIEW_PUBLIC_URL: malformedValue,
      REPLIT_EXPO_DEV_DOMAIN: "fallback-preview.example.test",
      PREVIEW_PUBLIC_TIMEOUT_MS: "25",
      PREVIEW_STARTUP_TIMEOUT_MS: "2000",
      PREVIEW_STARTUP_TEST_FIXTURE: "handoff-server",
    });

    assert.equal(result.status, 1);
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(
      summary,
      /Public Expo preview manifest URL configuration from PREVIEW_PUBLIC_URL is invalid/,
    );
    assert.ok(!summary.includes(malformedValue));
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
