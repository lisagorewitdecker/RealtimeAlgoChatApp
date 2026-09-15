import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Readiness and API requests must not hang indefinitely when the database
  // endpoint is unreachable.
  connectionTimeoutMillis: 5_000,
});

export function handlePoolError(error: Error): void {
  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  console.error(
    "PostgreSQL pool client error; the failed idle connection was discarded and future queries will reconnect.",
    {
      name: error.name,
      message: error.message,
      ...(code ? { code } : {}),
    },
  );
}

// node-postgres emits `error` for idle clients that are disconnected by the
// server. Without a listener, EventEmitter treats it as an uncaught exception
// and terminates the API process even though the pool can create a replacement.
pool.on("error", handlePoolError);

export const db = drizzle(pool, { schema });

export * from "./schema";
