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

test("live and captured preview validation report the same runtime-library diagnosis", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "chat-preview-runtime-diagnostic-"),
  );

  try {
    const fixture = runNodeScript([fixturePath]);
    assert.equal(fixture.status, 1);
    assert.match(fixture.output, /error while loading shared libraries/i);

    const capturedLogPath = join(temporaryDirectory, "expo-startup.log");
    writeFileSync(capturedLogPath, fixture.output, "utf8");

    const captured = runNodeScript([validatorPath, "--log-file", capturedLogPath]);
    const live = runNodeScript([validatorPath], {
      PREVIEW_STARTUP_TEST_FIXTURE: "missing-runtime-library",
    });

    assert.notEqual(captured.status, 0);
    assert.notEqual(live.status, 0);

    const capturedDiagnostic = findDiagnostic(captured.output);
    const liveDiagnostic = findDiagnostic(live.output);
    assert.equal(liveDiagnostic, capturedDiagnostic);
    assert.match(
      capturedDiagnostic,
      /shared libraries: libgtk-3\.so\.0: cannot open shared object file/,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});