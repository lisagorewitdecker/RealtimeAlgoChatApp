import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runtimeConfigFixtureVariable,
  runtimeConfigPathVariable,
} from "./playwright-runtime-config.mjs";
import { requiredChromiumRuntimePackages } from "./playwright-runtime-packages.mjs";
import { throwTestAndCleanupFailures } from "./clerk-retry.js";

describe("throwTestAndCleanupFailures", () => {
  it("retains both the original test failure and cleanup failures", () => {
    const testFailure = new Error("assertion failed");
    const cleanupFailure = new Error("delete failed");

    expect(() =>
      throwTestAndCleanupFailures(
        testFailure,
        [cleanupFailure],
        "cleanup failed",
        "test and cleanup failed",
      ),
    ).toThrow(
      expect.objectContaining({
        message: "test and cleanup failed",
        errors: [testFailure, cleanupFailure],
      }),
    );
  });

  it("rethrows the original failure when cleanup succeeds", () => {
    const testFailure = new Error("assertion failed");
    expect(() =>
      throwTestAndCleanupFailures(
        testFailure,
        [],
        "cleanup failed",
        "test and cleanup failed",
      ),
    ).toThrow(testFailure);
  });
});

describe("key-reset recovery Playwright diagnostics", () => {
  const apiServerDirectory = fileURLToPath(new URL("..", import.meta.url));
  // Budget for spawning `pnpm exec playwright test` with a real Chromium for
  // the diagnostic contracts below: about 6 s on an idle workspace, and
  // completion validation runs other suites alongside this one. It covers
  // process startup only; the 250 ms diagnostic timeouts under test are the
  // spec's own.
  const diagnosticRunTimeoutMs = 30_000;
  const diagnosticTestTimeoutMs = diagnosticRunTimeoutMs + 15_000;
  const recoveryPhases = [
    {
      phase: "sign in creator and create encrypted room",
      action: "page.goto",
    },
    {
      phase: "sign in member and receive initial room key",
      action: "locator.click",
    },
    {
      phase: "store encrypted history before key reset",
      action: "locator.fill",
    },
    {
      phase: "reset member device key in a second session",
      action: "locator.click",
    },
    {
      phase: "recover a fresh room-key envelope after reset",
      action: "locator.click",
    },
    {
      phase: "decrypt history and a new message with recovered key",
      action: "locator.fill",
    },
    {
      phase: "reload room after resetting the session key",
      action: "page.reload",
    },
    {
      phase: "leave and reopen room with recovered key",
      action: "locator.click",
    },
  ] as const;

  it("reports a browser setup error before recovery diagnostics can be misleading", () => {
    const emptyBrowserDirectory = mkdtempSync(
      join(tmpdir(), "missing-playwright-browser-"),
    );
    try {
      const result = spawnSync(
        "node",
        ["e2e/check-playwright-runtime.mjs"],
        {
          cwd: apiServerDirectory,
          encoding: "utf8",
          env: {
            ...process.env,
            PLAYWRIGHT_BROWSERS_PATH: emptyBrowserDirectory,
          },
          timeout: 10_000,
        },
      );
      const report = `${result.stdout}\n${result.stderr}`;

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(report).toContain("[api-server browser setup]");
      expect(report).toContain("Chromium is not ready for API tests");
      expect(report).not.toContain(
        "Key-reset recovery verification and cleanup both failed",
      );
    } finally {
      rmSync(emptyBrowserDirectory, { recursive: true, force: true });
    }
  });

  it.each(requiredChromiumRuntimePackages)(
    "reports the browser setup error when required runtime package %s is removed",
    (removedPackage) => {
      const runtimeDirectory = mkdtempSync(
        join(tmpdir(), "incomplete-playwright-runtime-"),
      );
      const runtimeConfigPath = join(runtimeDirectory, ".replit");
      try {
        const remainingPackages = requiredChromiumRuntimePackages.filter(
          (packageName) => packageName !== removedPackage,
        );
        writeFileSync(
          runtimeConfigPath,
          `[nix]\npackages = [${remainingPackages.map((name) => `"${name}"`).join(", ")}]\n`,
        );
        const result = spawnSync(
          "node",
          ["e2e/check-playwright-runtime.mjs"],
          {
            cwd: apiServerDirectory,
            encoding: "utf8",
            env: {
              ...process.env,
              // The fixture config path is honored only with its explicit
              // opt-in; an inherited path alone stays inert.
              [runtimeConfigFixtureVariable]: "1",
              [runtimeConfigPathVariable]: runtimeConfigPath,
            },
            timeout: 10_000,
          },
        );
        const report = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(report).toContain("[api-server browser setup]");
        expect(report).toContain("Chromium is not ready for API tests");
        expect(report).toContain(
          `Required Chromium runtime package "${removedPackage}"`,
        );
      } finally {
        rmSync(runtimeDirectory, { recursive: true, force: true });
      }
    },
  );

  it(
    "reports every recovery phase and its underlying action without external services",
    () => {
      const outputDirectory = mkdtempSync(
        join(tmpdir(), "recovery-diagnostic-"),
      );
      try {
        const result = spawnSync(
          "pnpm",
          [
            "exec",
            "playwright",
            "test",
            "e2e/key-reset-recovery.spec.ts",
            "--config",
            "e2e/playwright.config.ts",
            "--grep",
            "reports stalled recovery phases",
            "--output",
            outputDirectory,
          ],
          {
            cwd: apiServerDirectory,
            encoding: "utf8",
            env: {
              ...process.env,
              E2E_RECOVERY_DIAGNOSTIC_CONTRACT: "1",
              E2E_RECOVERY_DIAGNOSTIC_PHASES: recoveryPhases
                 .map(({ phase }) => phase)
                 .join(","),
              E2E_RECOVERY_DIAGNOSTIC_CLEANUP: "database",
            },
            timeout: diagnosticRunTimeoutMs,
          },
        );
        const report = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        for (const { phase, action } of recoveryPhases) {
          expect(report).toContain(phase);
          expect(report).toContain(action);
        }
        expect(report).toContain(
          "[key-reset-recovery-e2e] diagnostic cleanup executed",
        );
        expect(report).toContain(
          "Key-reset recovery verification and cleanup both failed",
        );
        expect(report).toContain(
          "Recovery room database cleanup timed out after 250ms",
        );
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    diagnosticTestTimeoutMs,
  );

  it.each([
    {
      cleanup: "browser",
      timeout: "Browser context cleanup timed out after 250ms",
    },
    {
      cleanup: "clerk-user",
      timeout:
        "Clerk user cleanup for diagnostic-user timed out after 250ms",
    },
    {
      cleanup: "pool",
      timeout: "Recovery database pool shutdown timed out after 250ms",
    },
  ])(
    "reports a stalled $cleanup cleanup without external services",
    ({ cleanup, timeout }) => {
      const outputDirectory = mkdtempSync(
        join(tmpdir(), `recovery-${cleanup}-diagnostic-`),
      );
      const phase = recoveryPhases[0]!;
      try {
        const result = spawnSync(
          "pnpm",
          [
            "exec",
            "playwright",
            "test",
            "e2e/key-reset-recovery.spec.ts",
            "--config",
            "e2e/playwright.config.ts",
            "--grep",
            "reports stalled recovery phases",
            "--output",
            outputDirectory,
          ],
          {
            cwd: apiServerDirectory,
            encoding: "utf8",
            env: {
              ...process.env,
              E2E_RECOVERY_DIAGNOSTIC_CONTRACT: "1",
              E2E_RECOVERY_DIAGNOSTIC_PHASES: phase.phase,
              E2E_RECOVERY_DIAGNOSTIC_CLEANUP: cleanup,
            },
            timeout: diagnosticRunTimeoutMs,
          },
        );
        const report = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        expect(report).toContain(phase.phase);
        expect(report).toContain(phase.action);
        expect(report).toContain(
          "Key-reset recovery verification and cleanup both failed",
        );
        expect(report).toContain(timeout);
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    diagnosticTestTimeoutMs,
  );

  it.each([
    {
      cleanup: "browser",
      timeout: "Browser context cleanup timed out after 250ms",
    },
    {
      cleanup: "database",
      timeout: "Recovery room database cleanup timed out after 250ms",
    },
    {
      cleanup: "clerk-user",
      timeout:
        "Clerk user cleanup for diagnostic-user timed out after 250ms",
    },
    {
      cleanup: "pool",
      timeout: "Recovery database pool shutdown timed out after 250ms",
    },
  ])(
    "reports a cleanup-only $cleanup timeout after recovery diagnostics succeed",
    ({ cleanup, timeout }) => {
      const outputDirectory = mkdtempSync(
        join(tmpdir(), `recovery-${cleanup}-cleanup-only-diagnostic-`),
      );
      const phase = recoveryPhases[0]!;
      try {
        const result = spawnSync(
          "pnpm",
          [
            "exec",
            "playwright",
            "test",
            "e2e/key-reset-recovery.spec.ts",
            "--config",
            "e2e/playwright.config.ts",
            "--grep",
            "reports stalled recovery phases",
            "--output",
            outputDirectory,
          ],
          {
            cwd: apiServerDirectory,
            encoding: "utf8",
            env: {
              ...process.env,
              E2E_RECOVERY_DIAGNOSTIC_CONTRACT: "1",
              E2E_RECOVERY_DIAGNOSTIC_PHASES: phase.phase,
              E2E_RECOVERY_DIAGNOSTIC_PHASES_SUCCEED: "1",
              E2E_RECOVERY_DIAGNOSTIC_CLEANUP: cleanup,
            },
            timeout: diagnosticRunTimeoutMs,
          },
        );
        const report = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        expect(report).toContain(
          `[key-reset-recovery-e2e] diagnostic phase completed: ${phase.phase}`,
        );
        expect(report).toContain("Key-reset recovery E2E cleanup failed");
        expect(report).toContain(timeout);
        expect(report).not.toContain("Recovery diagnostic phase failed");
        expect(report).not.toContain(
          "Key-reset recovery verification and cleanup both failed",
        );
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    diagnosticTestTimeoutMs,
  );

  it(
    "preserves every cleanup-only timeout after recovery diagnostics succeed",
    () => {
      const outputDirectory = mkdtempSync(
        join(tmpdir(), "recovery-multiple-cleanup-only-diagnostic-"),
      );
      const phase = recoveryPhases[0]!;
      try {
        const result = spawnSync(
          "pnpm",
          [
            "exec",
            "playwright",
            "test",
            "e2e/key-reset-recovery.spec.ts",
            "--config",
            "e2e/playwright.config.ts",
            "--grep",
            "reports stalled recovery phases",
            "--output",
            outputDirectory,
          ],
          {
            cwd: apiServerDirectory,
            encoding: "utf8",
            env: {
              ...process.env,
              E2E_RECOVERY_DIAGNOSTIC_CONTRACT: "1",
              E2E_RECOVERY_DIAGNOSTIC_PHASES: phase.phase,
              E2E_RECOVERY_DIAGNOSTIC_PHASES_SUCCEED: "1",
              E2E_RECOVERY_DIAGNOSTIC_CLEANUP: "database,pool",
            },
            timeout: diagnosticRunTimeoutMs,
          },
        );
        const report = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.signal).toBeNull();
        expect(report).toContain(
          `[key-reset-recovery-e2e] diagnostic phase completed: ${phase.phase}`,
        );
        expect(report).toContain("Key-reset recovery E2E cleanup failed");
        expect(report).toContain(
          "Recovery room database cleanup timed out after 250ms",
        );
        expect(report).toContain(
          "Recovery database pool shutdown timed out after 250ms",
        );
        expect(report).not.toContain("Recovery diagnostic phase failed");
        expect(report).not.toContain(
          "Key-reset recovery verification and cleanup both failed",
        );
      } finally {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    diagnosticTestTimeoutMs,
  );
});
