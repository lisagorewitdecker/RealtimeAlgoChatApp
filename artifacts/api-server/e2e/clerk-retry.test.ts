import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { requiredChromiumRuntimePackages } from "./playwright-runtime-packages.mjs";
import {
  throwTestAndCleanupFailures,
  withClerkRetry,
  withClerkSetupRetry,
} from "./clerk-retry.js";

describe("withClerkRetry", () => {
  it.each([429, 500, 502, 503, 504])(
    "retries Clerk status %i",
    async (status) => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status })
        .mockResolvedValue("created");
      const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

      await expect(
        withClerkRetry("create user", operation, {
          attempts: 2,
          baseDelayMs: 10,
          sleep,
        }),
      ).resolves.toBe("created");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(10);
    },
  );

  it("supports Clerk errors that expose statusCode", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ statusCode: 502 })
      .mockResolvedValue("token");

    await expect(
      withClerkRetry("mint token", operation, {
        attempts: 2,
        baseDelayMs: 0,
      }),
    ).resolves.toBe("token");
  });

  it("uses numeric Clerk retry guidance when it exceeds backoff", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 429, retryAfter: 3 })
      .mockResolvedValue("session");
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      withClerkRetry("create session", operation, {
        attempts: 2,
        baseDelayMs: 10,
        sleep,
      }),
    ).resolves.toBe("session");
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it.each(["later", Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "falls back to exponential backoff for malformed retry guidance %s",
    async (retryAfter) => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status: 429, retryAfter })
        .mockResolvedValue("session");
      const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

      await withClerkRetry("create session", operation, {
        attempts: 2,
        baseDelayMs: 25,
        sleep,
      });
      expect(sleep).toHaveBeenCalledWith(25);
    },
  );

  it("uses bounded exponential backoff when retry guidance is absent", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue("session");
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

    await withClerkRetry("create session", operation, {
      attempts: 3,
      baseDelayMs: 20_000,
      sleep,
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 20_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 30_000);
  });

  it("does not retry permanent failures", async () => {
    const failure = { status: 400 };
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(
      withClerkRetry("create session", operation, {
        attempts: 5,
        baseDelayMs: 0,
      }),
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("withClerkSetupRetry", () => {
  it("retries temporary Clerk setup failures with bounded backoff", async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValue();
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      withClerkSetupRetry(operation, {
        attempts: 3,
        baseDelayMs: 25,
        sleep,
      }),
    ).resolves.toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[25], [50]]);
  });

  it.each([401, 403])(
    "fails immediately for permanent Clerk setup status %i",
    async (status) => {
      const failure = { status };
      const operation = vi.fn().mockRejectedValue(failure);
      const sleep = vi.fn<() => Promise<void>>().mockResolvedValue();

      await expect(
        withClerkSetupRetry(operation, {
          attempts: 5,
          baseDelayMs: 25,
          sleep,
        }),
      ).rejects.toBe(failure);
      expect(operation).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});

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
      action: "page.goto",
    },
    {
      phase: "decrypt history and a new message with recovered key",
      action: "locator.fill",
    },
    {
      phase: "reload room and reuse recovered key",
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
              PLAYWRIGHT_RUNTIME_CONFIG_PATH: runtimeConfigPath,
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
            timeout: 15_000,
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
    20_000,
  );

  it.each([
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
            timeout: 15_000,
          },
        );
        const report = `${result.stdout}\n${result.stderr}`;

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
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
    20_000,
  );
});
