import { execFile } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const runningProcesses = new Set<ReturnType<typeof execFile>>();
const artifactRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = path.resolve(artifactRoot, "../..");
const productionArgs = [
  "--enable-source-maps",
  "--import",
  "./artifacts/api-server/dist/instrument.mjs",
  "./artifacts/api-server/dist/index.mjs",
];
const missingModuleArgs = [
  "--enable-source-maps",
  "--import",
  "./artifacts/api-server/dist/missing-instrument.mjs",
  "./artifacts/api-server/dist/index.mjs",
];

function validEnvironment(port: number): NodeJS.ProcessEnv {
  if (!process.env["DATABASE_URL"]) {
    throw new Error(
      "DATABASE_URL is required to exercise production readiness.",
    );
  }

  const encodedFrontendApi = Buffer.from("clerk.example.com$").toString(
    "base64",
  );

  return {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    CLERK_PUBLISHABLE_KEY: `pk_test_${encodedFrontendApi}`,
    CLERK_SECRET_KEY: "sk_test_startup-regression-placeholder",
    SENTRY_DSN: "",
  };
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a startup test port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForResponse(
  child: ReturnType<typeof execFile>,
  url: string,
): Promise<Response> {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Production server exited before readiness:\n${output}`);
    }

    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Production server did not become ready:\n${output}`);
}

async function waitForExit(
  child: ReturnType<typeof execFile>,
): Promise<{ code: number | null; output: string }> {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output };
}

beforeAll(async () => {
  await execFileAsync(process.execPath, ["./build.mjs"], {
    cwd: artifactRoot,
    env: process.env,
  });
}, 60_000);

afterEach(async () => {
  const exits = [...runningProcesses].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  );
  await Promise.all(exits);
  runningProcesses.clear();
});

describe("built production server startup", () => {
  it(
    "serves every public readiness route with valid configuration",
    async () => {
      const port = await availablePort();
      const child = execFile(process.execPath, productionArgs, {
        cwd: workspaceRoot,
        env: validEnvironment(port),
      });
      runningProcesses.add(child);

      const firstResponse = await waitForResponse(
        child,
        `http://127.0.0.1:${port}/api/healthz`,
      );
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toEqual({ status: "ok" });

      for (const path of ["/", "/api"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "ready",
          healthCheck: "/api/healthz",
        });
      }
    },
    90_000,
  );

  it.each([
    ["missing", undefined],
    ["invalid", "not-a-publishable-key"],
  ])(
    "exits immediately with a safe diagnostic for %s Clerk configuration",
    async (_scenario, publishableKey) => {
      const port = await availablePort();
      const env = validEnvironment(port);
      if (publishableKey === undefined) {
        delete env["CLERK_PUBLISHABLE_KEY"];
      } else {
        env["CLERK_PUBLISHABLE_KEY"] = publishableKey;
      }

      const child = execFile(process.execPath, productionArgs, {
        cwd: workspaceRoot,
        env,
      });
      runningProcesses.add(child);
      const { code, output } = await waitForExit(child);

      expect(code).not.toBe(0);
      expect(output).toContain("API server startup configuration is invalid:");
      expect(output).toContain("CLERK_PUBLISHABLE_KEY");
      expect(output).toContain("Update the deployment environment");
      expect(output).not.toContain(env["CLERK_SECRET_KEY"]);
      expect(output).not.toContain("Server listening");
    },
    90_000,
  );

  it(
    "reports the actual missing production preload module",
    async () => {
      const port = await availablePort();
      const child = execFile(process.execPath, missingModuleArgs, {
        cwd: workspaceRoot,
        env: validEnvironment(port),
      });
      runningProcesses.add(child);

      const { code, output } = await waitForExit(child);

      expect(code).not.toBe(0);
      expect(output).toContain("ERR_MODULE_NOT_FOUND");
      expect(output).toContain("dist/missing-instrument.mjs");
      expect(output).not.toContain("Server listening");
      expect(output).not.toContain(validEnvironment(port)["CLERK_SECRET_KEY"]);
    },
    90_000,
  );
});