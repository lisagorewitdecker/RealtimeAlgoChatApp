/* jshint esversion: 8 */
const {
  createStaticServer,
  loadStaticFiles,
  resolveStaticPath,
} = require("./serve");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

function getHttpResponse(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          body,
        });
      });
    });
    request.on("error", reject);
  });
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
      const response = await getHttpResponse(
        `http://127.0.0.1:${address.port}/status`,
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ status: "ok" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("uses the Expo app name for landing-page branding", async () => {
    const server = createStaticServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      const response = await getHttpResponse(
        `http://127.0.0.1:${address.port}/`,
      );
      const html = response.body;

      expect(response.status).toBe(200);
      expect(html).toContain("<title>RealtimeAlgoChatApp Studio</title>");
      expect(html).toContain("<h1>RealtimeAlgoChatApp Studio</h1>");
      expect(html).not.toMatch(/DevAlgoChat|DevStudio|ChatSphere/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("describes the landing page without claiming Expo Go is the product download", async () => {
    const server = createStaticServer();

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      const response = await getHttpResponse(
        `http://127.0.0.1:${address.port}/`,
      );
      const jsonLdMatch = response.body.match(
        /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/,
      );

      expect(response.status).toBe(200);
      expect(jsonLdMatch).not.toBeNull();

      const structuredData = JSON.parse(jsonLdMatch[1]);

      expect(structuredData).toEqual({
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: "RealtimeAlgoChatApp Studio mobile preview",
        description:
          "Get RealtimeAlgoChatApp Studio on your phone: real-time code collaboration, calls, and chat for developers.",
        url: `https://127.0.0.1:${address.port}/`,
      });
      expect(structuredData).not.toHaveProperty("downloadUrl");
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
});