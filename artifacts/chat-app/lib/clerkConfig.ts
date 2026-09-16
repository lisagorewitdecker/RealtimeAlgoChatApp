export type ClerkEnvironment = Record<string, string | undefined>;

export type ClerkConfiguration =
  | {
      status: "ready";
      publishableKey: string;
      source: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY" | "VITE_CLERK_PUBLISHABLE_KEY";
    }
  | {
      status: "missing" | "invalid";
      message: string;
      source?: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY" | "VITE_CLERK_PUBLISHABLE_KEY";
    };

const publishableKeyPattern = /^pk_(?:test|live)_[A-Za-z0-9_-]+$/;
const environmentKeys = [
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_PUBLISHABLE_KEY",
] as const;

export function getClerkConfiguration(
  environment: ClerkEnvironment = process.env,
): ClerkConfiguration {
  for (const source of environmentKeys) {
    const publishableKey = environment[source]?.trim();
    if (!publishableKey) continue;

    if (!publishableKeyPattern.test(publishableKey)) {
      return {
        status: "invalid",
        source,
        message:
          "The Clerk publishable key is not valid. Ask the project owner to check the managed Clerk configuration, then reload the app.",
      };
    }

    return { status: "ready", publishableKey, source };
  }

  return {
    status: "missing",
    message:
      "Authentication setup is incomplete. Ask the project owner to provide the managed Clerk publishable key, then reload the app.",
  };
}