import { createServer } from "node:http";
import { loadStartupConfig } from "./config";
import { Sentry } from "./lib/sentry";
import { logger } from "./lib/logger";

async function startServer(): Promise<void> {
  // Validate before importing the application graph. Those imports construct
  // Clerk middleware and initialize the database package.
  const { port } = loadStartupConfig();
  const [{ default: app }, { setupSocketIO }, { startHealthMonitor }] =
    await Promise.all([
      import("./app"),
      import("./socket"),
      import("./lib/healthMonitor"),
    ]);

  const httpServer = createServer(app);
  setupSocketIO(httpServer);

  httpServer.on("error", (err) => {
    Sentry.captureException(err);
    logger.error({ err }, "HTTP server error");
  });

  httpServer.listen(port, () => {
    logger.info({ port }, "Server listening");
    startHealthMonitor(port);
  });
}

startServer().catch(async (err: unknown) => {
  Sentry.captureException(err);
  logger.fatal({ err }, "API server startup failed");
  await Sentry.flush(2_000);
  process.exitCode = 1;
});
