import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import pinoHttp from "pino-http";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import router from "./routes";
import { logger } from "./lib/logger";
import { isAllowedOrigin } from "./lib/origins";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { Sentry } from "./lib/sentry";
import healthRouter from "./routes/health";

const app: Express = express();
const require = createRequire(import.meta.url);
const socketClientScript = join(
  dirname(require.resolve("socket.io")),
  "..",
  "client-dist",
  "socket.io.js",
);
const cryptoClientScript = join(dirname(fileURLToPath(import.meta.url)), "crypto-client.js");
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Readiness is public, but only after the startup configuration gate has
// succeeded. Keep these routes ahead of Clerk so health checks do not depend on
// per-request authentication parsing.
app.get("/", (_req, res) => {
  res.status(200).json({
    status: "ready",
    api: "/api",
    healthCheck: "/api/healthz",
  });
});
app.get("/api", (_req, res) => {
  res.status(200).json({
    status: "ready",
    healthCheck: "/api/healthz",
  });
});
app.use("/api", healthRouter);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(
  clerkMiddleware((req) => {
    const host = getClerkProxyHost(req);
    return process.env["NODE_ENV"] === "production" && host
      ? { proxyUrl: `https://${host}${CLERK_PROXY_PATH}` }
      : {};
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/socket-client.js", (_req, res) => {
  res
    .type("application/javascript")
    .sendFile(socketClientScript, { dotfiles: "allow" });
});
app.get("/api/crypto-client.js", (_req, res) => {
  res
    .type("application/javascript")
    .sendFile(cryptoClientScript, { dotfiles: "allow" });
});
app.use("/api", router);

// Forward unhandled route errors to Sentry (grouped, searchable issues)
// before falling back to a generic JSON response.
Sentry.setupExpressErrorHandler(app);

app.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    logger.error({ err }, "Unhandled request error");
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({ error: "Internal server error" });
  },
);

export default app;
