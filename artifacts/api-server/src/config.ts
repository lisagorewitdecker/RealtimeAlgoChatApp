import {
  isDevelopmentFromPublishableKey,
  isDevelopmentFromSecretKey,
  isProductionFromPublishableKey,
  isProductionFromSecretKey,
  isPublishableKey,
} from "@clerk/shared/keys";

export type StartupConfig = {
  port: number;
};

function clerkEnvironment(
  key: string,
  isDevelopment: (value: string) => boolean,
  isProduction: (value: string) => boolean,
): "development" | "production" | undefined {
  if (isDevelopment(key)) return "development";
  if (isProduction(key)) return "production";
  return undefined;
}

function isValidSecretKey(key: string): boolean {
  return /^(?:sk_)?(?:test|live)_\S+$/.test(key);
}

function isValidDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}

export function loadStartupConfig(
  env: NodeJS.ProcessEnv = process.env,
): StartupConfig {
  const issues: string[] = [];

  const rawPort = env["PORT"];
  const port = Number(rawPort);
  if (
    !rawPort ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    issues.push("PORT must be an integer between 1 and 65535.");
  }

  const databaseUrl = env["DATABASE_URL"] ?? "";
  if (!databaseUrl) {
    issues.push("DATABASE_URL is required.");
  } else if (!isValidDatabaseUrl(databaseUrl)) {
    issues.push("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  const publishableKey = env["CLERK_PUBLISHABLE_KEY"] ?? "";
  if (!publishableKey) {
    issues.push("CLERK_PUBLISHABLE_KEY is required.");
  } else if (!isPublishableKey(publishableKey)) {
    issues.push(
      "CLERK_PUBLISHABLE_KEY must use Clerk's pk_test_... or pk_live_... format.",
    );
  }

  const secretKey = env["CLERK_SECRET_KEY"] ?? "";
  if (!secretKey) {
    issues.push("CLERK_SECRET_KEY is required.");
  } else if (!isValidSecretKey(secretKey)) {
    issues.push(
      "CLERK_SECRET_KEY must use Clerk's sk_test_... or sk_live_... format.",
    );
  }

  if (
    publishableKey &&
    secretKey &&
    isPublishableKey(publishableKey) &&
    isValidSecretKey(secretKey)
  ) {
    const publishableEnvironment = clerkEnvironment(
      publishableKey,
      isDevelopmentFromPublishableKey,
      isProductionFromPublishableKey,
    );
    const secretEnvironment = clerkEnvironment(
      secretKey,
      isDevelopmentFromSecretKey,
      isProductionFromSecretKey,
    );

    if (
      publishableEnvironment &&
      secretEnvironment &&
      publishableEnvironment !== secretEnvironment
    ) {
      issues.push(
        "CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY must belong to the same Clerk environment.",
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(
      [
        "API server startup configuration is invalid:",
        ...issues.map((issue) => `- ${issue}`),
        "Update the deployment environment and restart the service.",
      ].join("\n"),
    );
  }

  return { port };
}