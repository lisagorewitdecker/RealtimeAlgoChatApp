import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptsDirectory = import.meta.dirname;
const validatorPath = join(scriptsDirectory, "validate-preview-startup.mjs");
const fixturePath = join(
  scriptsDirectory,
  "preview-startup-runtime-library-fixture.mjs",
);

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

const fixtures = [
  {
    name: "Linux shared-library loader",
    fixture: "missing-runtime-library",
    detail: /shared libraries: libgtk-3\.so\.0: cannot open shared object file/,
  },
  {
    name: "macOS dyld loader",
    fixture: "missing-runtime-library-dyld",
    detail: /Library not loaded: \/opt\/homebrew\/lib\/libgtk-3\.dylib/,
  },
  {
    name: "Windows loader",
    fixture: "missing-runtime-library-windows",
    detail: /cannot proceed because libgtk-3-0\.dll was not found/,
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
      assert.ok(
        capturedDiagnostic.length <= 512,
        `${fixtureCase.name} diagnostic exceeded the 512-character limit`,
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});