import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const artifactRoot = fileURLToPath(new URL("../", import.meta.url));

// Runs inside a child process started with the built preload. It samples the
// process's OS thread count twice: once after the development logger's
// transport worker has had time to start, and again after a settle period.
// A preload that does work inside worker threads spawns another pino
// transport worker every few hundred milliseconds, so the second sample keeps
// climbing instead of matching the first.
const threadCountScript = `
  const { readdirSync } = require("node:fs");
  const count = () => readdirSync("/proc/self/task").length;
  setTimeout(() => {
    const first = count();
    setTimeout(() => {
      console.log(JSON.stringify({ first, second: count() }));
    }, 3000);
  }, 2000);
`;

beforeAll(async () => {
  await execFileAsync(process.execPath, ["./build.mjs"], {
    cwd: artifactRoot,
    env: process.env,
  });
}, 60_000);

describe("built instrument preload", () => {
  it.skipIf(process.platform !== "linux")(
    "does not spawn worker threads from the development logger transport",
    async () => {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "./dist/instrument.mjs", "-e", threadCountScript],
        {
          cwd: artifactRoot,
          env: { ...process.env, NODE_ENV: "development", SENTRY_DSN: "" },
          timeout: 30_000,
        },
      );

      const output = `${stdout}${stderr}`;
      const sample = output.match(/\{"first":\d+,"second":\d+\}/);
      expect(sample, output).not.toBeNull();
      const { first, second } = JSON.parse(sample![0]) as {
        first: number;
        second: number;
      };

      expect(first).toBeGreaterThan(1);
      expect(second, output).toBeLessThanOrEqual(first + 1);
      // The main thread still owns exactly one logger, so the preload's own
      // warning appears once — not once per spawned worker.
      expect(output.match(/SENTRY_DSN is not set/g)).toHaveLength(1);
    },
    45_000,
  );
});
