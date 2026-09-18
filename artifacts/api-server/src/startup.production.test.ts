import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
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

type StalledDatabase = {
  server: Server;
  sockets: Set<Socket>;
  port: number;
};

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

async function startStalledDatabase(): Promise<StalledDatabase> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    // Accept the connection but never complete the PostgreSQL handshake. This
    // exercises the production pool timeout without requiring a real database
    // to be stopped or reconfigured.
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to start the stalled database fixture.");
  }

  return { server, sockets, port: address.port };
}

async function stopStalledDatabase({
  server,
  sockets,
}: StalledDatabase): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
    "serves the public liveness and readiness routes with valid configuration",
    async () => {
      const port = await availablePort();
      const child = execFile(process.execPath, productionArgs, {
        cwd: workspaceRoot,
        env: validEnvironment(port),
      });
      runningProcesses.add(child);

      const firstResponse = await waitForResponse(
        child,
        `http://127.0.0.1:${port}/api/livez`,
      );
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toEqual({ status: "ok" });

      const readinessResponse = await fetch(
        `http://127.0.0.1:${port}/api/healthz`,
      );
      expect(readinessResponse.status).toBe(200);
      expect(await readinessResponse.json()).toEqual({ status: "ok" });

      for (const path of ["/", "/api"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "ready",
          healthCheck: "/api/healthz",
          livenessCheck: "/api/livez",
        });
      }
    },
    90_000,
  );

  it(
    "keeps liveness available while database-backed readiness times out",
    async () => {
      const stalledDatabase = await startStalledDatabase();
      const port = await availablePort();
      const env = validEnvironment(port);
      env["DATABASE_URL"] =
        `postgresql://127.0.0.1:${stalledDatabase.port}/readiness-timeout`;
      const child = execFile(process.execPath, productionArgs, {
        cwd: workspaceRoot,
        env,
      });
      runningProcesses.add(child);

      try {
        const livenessResponse = await waitForResponse(
          child,
          `http://127.0.0.1:${port}/api/livez`,
        );
        expect(livenessResponse.status).toBe(200);
        expect(await livenessResponse.json()).toEqual({ status: "ok" });

        const readinessResponsePromise = fetch(
          `http://127.0.0.1:${port}/api/healthz`,
        );
        const livenessDuringReadinessTimeout = await fetch(
          `http://127.0.0.1:${port}/api/livez`,
        );
        expect(livenessDuringReadinessTimeout.status).toBe(200);
        expect(await livenessDuringReadinessTimeout.json()).toEqual({
          status: "ok",
        });

        const readinessResponse = await readinessResponsePromise;
        expect(readinessResponse.status).toBe(503);
        expect(await readinessResponse.json()).toEqual({
          status: "unavailable",
        });
      } finally {
        await stopStalledDatabase(stalledDatabase);
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