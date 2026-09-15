/**
 * Standalone production server for Expo static builds.
 *
 * Serves the output of build.js (static-build/) with two special routes:
 * - GET / or /manifest with expo-platform header → platform manifest JSON
 * - GET / without expo-platform → landing page HTML
 * Everything else falls through to static file serving from ./static-build/.
 *
 * Zero external dependencies — uses only Node.js built-ins (http, fs, path).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const TEMPLATE_PATH = path.resolve(__dirname, "templates", "landing-page.html");
const basePath = (process.env.BASE_PATH || "/").replace(/\/+$/, "");
const STATIC_FILES = new Map();
let staticFilesReady = false;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json",
};

function getAppName() {
  try {
    const appJsonPath = path.resolve(__dirname, "..", "app.json");
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function getStaticRoot() {
  return path.resolve(
    process.env.STATIC_BUILD_DIR || path.resolve(__dirname, "..", "static-build"),
  );
}

function getPort() {
  const rawPort = process.env.PORT || "";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535; received "${rawPort || "<missing>"}".`,
    );
  }
  return port;
}

function formatStaticPreloadError(error, rootPath) {
  if (error && error.code === "ENOENT" && !fs.existsSync(rootPath)) {
    return new Error(
      `Static build directory not found at ${rootPath}. ` +
        "Run `pnpm --filter @workspace/chat-app run build` before starting the production server.",
    );
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Unable to load static build from ${rootPath}: ${detail}`);
}

function serveManifest(platform, res) {
  if (!staticFilesReady) {
    res.writeHead(503, {
      "content-type": "application/json",
      "retry-after": "1",
    });
    res.end(JSON.stringify({ error: "Static assets are still loading" }));
    return;
  }

  const manifest = STATIC_FILES.get(`/${platform}/manifest.json`);

  if (!manifest) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: `Manifest not found for platform: ${platform}` }),
    );
    return;
  }

  res.writeHead(200, {
    "content-type": "application/json",
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
  });
  res.end(manifest.content);
}

function serveLandingPage(req, res, landingPageTemplate, appName) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;
  const pageDescription = `Get ${appName} on your phone: real-time code collaboration, calls, and chat for developers.`;
  const socialDescription =
    "Real-time collaboration for developers — code sandbox, calls, and chat.";

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName)
    .replace(/PAGE_DESCRIPTION_PLACEHOLDER/g, pageDescription)
    .replace(/SOCIAL_DESCRIPTION_PLACEHOLDER/g, socialDescription);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function resolveStaticPath(urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return { error: 400 };
  }

  if (decodedPath.includes("\0")) {
    return { error: 400 };
  }

  const pathSegments = decodedPath.replace(/\\/g, "/").split("/");
  if (pathSegments.includes("..")) {
    return { error: 403 };
  }

  const pathKey = `/${pathSegments.filter((segment) => segment && segment !== ".").join("/")}`;
  return { pathKey };
}

function serveStaticFile(urlPath, res) {
  if (!staticFilesReady) {
    res.writeHead(503, { "retry-after": "1" });
    res.end("Static assets are still loading");
    return;
  }

  const resolved = resolveStaticPath(urlPath);
  if ("error" in resolved) {
    res.writeHead(resolved.error);
    res.end(resolved.error === 400 ? "Bad Request" : "Forbidden");
    return;
  }
  const staticFile = STATIC_FILES.get(resolved.pathKey);
  if (!staticFile) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  res.writeHead(200, { "content-type": staticFile.contentType });
  res.end(staticFile.content);
}

async function loadStaticFiles(rootPath) {
  const files = new Map();

  async function visit(directoryPath) {
    const entries = await fs.promises.readdir(directoryPath, {
      withFileTypes: true,
    });

    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
        } else if (entry.isFile()) {
          const relativePath = path.relative(rootPath, absolutePath);
          const pathKey = `/${relativePath.split(path.sep).join("/")}`;
          const ext = path.extname(absolutePath).toLowerCase();
          files.set(pathKey, {
            content: await fs.promises.readFile(absolutePath),
            contentType: MIME_TYPES[ext] || "application/octet-stream",
          });
        }
      }),
    );
  }

  await visit(rootPath);
  return files;
}

const landingPageTemplate = fs.readFileSync(TEMPLATE_PATH, "utf-8");
const appName = getAppName();

function createStaticServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    let pathname = url.pathname;

    if (basePath && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length) || "/";
    }

    if (pathname === "/status") {
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (pathname === "/" || pathname === "/manifest") {
      const platform = req.headers["expo-platform"];
      if (platform === "ios" || platform === "android") {
        return serveManifest(platform, res);
      }

      if (pathname === "/") {
        return serveLandingPage(req, res, landingPageTemplate, appName);
      }
    }

    serveStaticFile(pathname, res);
  });
}

async function startProductionServer() {
  const port = getPort();
  const staticRoot = getStaticRoot();
  const server = createStaticServer();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  console.log(`Serving static Expo build on port ${port}`);

  try {
    const files = await loadStaticFiles(staticRoot);
    STATIC_FILES.clear();
    for (const [pathKey, staticFile] of files) {
      STATIC_FILES.set(pathKey, staticFile);
    }
    staticFilesReady = true;
    console.log(`Preloaded ${STATIC_FILES.size} static files`);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw formatStaticPreloadError(error, staticRoot);
  }

  return server;
}

if (require.main === module) {
  startProductionServer().catch((error) => {
    console.error(`Production startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createStaticServer,
  loadStaticFiles,
  resolveStaticPath,
  startProductionServer,
};
