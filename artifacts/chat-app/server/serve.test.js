const {
  createStaticServer,
  loadStaticFiles,
  resolveStaticPath,
} = require("./serve");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const appRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(appRoot, "../..");
const publishEntrypoint = "artifacts/chat-app/server/serve.js";

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = require("net").createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForResponse(child, url) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
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

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

describe("static file path resolution", () => {
  it("keeps normal asset paths inside the static build directory", () => {
    const result = resolveStaticPath("/assets/app.js");

    expect(result).toEqual({ pathKey: "/assets/app.js" });
  });

  it.each([
    "/../app.json",
    "/%2e%2e/app.json",
    "/assets/../../server/serve.js",
  ])("rejects traversal path %s", (candidate) => {
    expect(resolveStaticPath(candidate)).toEqual({ error: 403 });
  });

  it("rejects malformed URL encoding", () => {
    expect(resolveStaticPath("/%E0%A4%A")).toEqual({ error: 400 });
  });

  it("preloads static files into an allowlisted in-memory map", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-static-"));
    const nested = path.join(root, "assets");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "app.js"), "console.log('ready');");

    try {
      const files = await loadStaticFiles(root);

      expect(files.get("/assets/app.js")).toEqual({
        content: Buffer.from("console.log('ready');"),
        contentType: "application/javascript; charset=utf-8",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers the startup probe before static asset preloading finishes", async () => {
    const server = createStaticServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/status`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("uses the Expo app name for landing-page branding", async () => {
    const server = createStaticServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("<title>RealtimeAlgoChatApp Studio</title>");
      expect(html).toContain("<h1>RealtimeAlgoChatApp Studio</h1>");
      expect(html).not.toMatch(/DevAlgoChat|DevStudio|ChatSphere/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keeps the owner copyright footer dynamic", () => {
    const template = fs.readFileSync(
      path.join(__dirname, "templates", "landing-page.html"),
      "utf8",
    );

    expect(template).toContain("© <span id=\"copyright-year\"></span> Lisa M Gorewit-Decker");
    expect(template).toContain("new Date().getFullYear()");
  });

  it("launches the publish entrypoint and serves status plus the landing page", async () => {
    const port = await getAvailablePort();
    const child = execFile(process.execPath, [publishEntrypoint], {
      cwd: workspaceRoot,
      env: { ...process.env, PORT: String(port), BASE_PATH: "/" },
    });

    try {
      const status = await waitForResponse(
        child,
        `http://127.0.0.1:${port}/status`,
      );
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toEqual({ status: "ok" });

      const landing = await fetch(`http://127.0.0.1:${port}/`);
      expect(landing.status).toBe(200);
      expect(await landing.text()).toContain(
        "<h1>RealtimeAlgoChatApp Studio</h1>",
      );
    } finally {
      await stopChild(child);
    }
  });

  it("reports a missing static build instead of only a port timeout", async () => {
    const port = await getAvailablePort();
    const missingRoot = path.join(
      os.tmpdir(),
      `chat-static-missing-${process.pid}-${Date.now()}`,
    );
    const child = execFile(process.execPath, [publishEntrypoint], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PORT: String(port),
        BASE_PATH: "/",
        STATIC_BUILD_DIR: missingRoot,
      },
    });

    const { code, output } = await waitForExit(child);
    expect(code).not.toBe(0);
    expect(output).toContain("Production startup failed:");
    expect(output).toContain(`Static build directory not found at ${missingRoot}`);
    expect(output).toContain(
      "pnpm --filter @workspace/chat-app run build",
    );
  });
});