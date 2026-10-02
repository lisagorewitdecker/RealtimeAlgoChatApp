import { Router } from "express";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { logger } from "../lib/logger";

const router = Router();

let _naclJs: string | null = null;

function getNaclJs(): string {
  if (_naclJs) return _naclJs;
  try {
    const require = createRequire(import.meta.url);
    const naclPath = require.resolve("tweetnacl");
    _naclJs = readFileSync(naclPath, "utf-8");
    return _naclJs;
  } catch (err) {
    logger.error({ err }, "Failed to load tweetnacl");
    throw err;
  }
}

// Serve tweetnacl as a browser-compatible script at /api/crypto/tweetnacl.js
router.get("/tweetnacl.js", (_req, res) => {
  try {
    const src = getNaclJs();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(src);
  } catch {
    res.status(500).send("// tweetnacl not available");
  }
});

export default router;
