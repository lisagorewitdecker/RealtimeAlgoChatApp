import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const artifactRoot = fileURLToPath(new URL("../", import.meta.url));

beforeAll(async () => {
  await execFileAsync(process.execPath, ["./build.mjs"], {
    cwd: artifactRoot,
    env: process.env,
  });
}, 60_000);

describe("bundled logging assets", () => {
  it("are complete and relocatable", async () => {
    await expect(
      execFileAsync(process.execPath, ["./check-logging-assets.mjs"], {
        cwd: artifactRoot,
      }),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("fail the startup check when a worker is missing", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "api-logging-assets-"),
    );
    const temporaryDist = path.join(temporaryRoot, "dist");

    try {
      await cp(path.join(artifactRoot, "dist"), temporaryDist, {
        recursive: true,
      });
      await unlink(path.join(temporaryDist, "thread-stream-worker.mjs"));

      await expect(
        execFileAsync(
          process.execPath,
          ["./check-logging-assets.mjs", temporaryDist],
          { cwd: artifactRoot },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("missing thread-stream-worker.mjs"),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});