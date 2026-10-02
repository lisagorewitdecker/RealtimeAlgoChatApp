import { Router } from "express";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../lib/logger";

/**
 * Socket.IO's built-in client serving (`<path>/socket.io.js`) resolves its
 * asset relative to the socket.io package on disk, which breaks once the
 * server is bundled by esbuild. Serve the browser client ourselves instead.
 */

const router = Router();

let _clientJs: string | null = null;

function getSocketIoClientJs(): string {
  if (_clientJs) return _clientJs;
  const require = createRequire(import.meta.url);
  // socket.io's exports map does not expose client-dist as a subpath, so
  // resolve the package root and walk to the asset.
  const pkgRoot = dirname(require.resolve("socket.io/package.json"));
  const clientPath = join(pkgRoot, "client-dist", "socket.io.min.js");
  _clientJs = readFileSync(clientPath, "utf-8");
  return _clientJs;
}

router.get("/socket.io.js", (_req, res) => {
  try {
    const src = getSocketIoClientJs();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(src);
  } catch (err) {
    logger.error({ err }, "Failed to load socket.io browser client");
    res.status(500).send("// socket.io client not available");
  }
});

export default router;
