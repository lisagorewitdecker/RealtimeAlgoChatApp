import Constants, { ExecutionEnvironment } from "expo-constants";
import {
  RELEASE_BUILD_CREATED_AT,
  RELEASE_SENTRY_BUILD_ID,
} from "@/constants/releaseCrashReporting";

export type BuildIdentity = {
  appVersion: string;
  createdAt: string;
  runtimeVersion: string;
  clientType: "Development preview" | "Expo Go" | "Published build";
  buildId: string;
};

type ManifestWithBuildTime = {
  createdAt?: unknown;
  publishedTime?: unknown;
};

function readableTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function getBuildIdentity(): BuildIdentity {
  const manifest = Constants.manifest as ManifestWithBuildTime | null;
  const manifest2 = Constants.manifest2 as ManifestWithBuildTime | null;
  const createdAt =
    readableTimestamp(manifest2?.createdAt) ??
    readableTimestamp(manifest2?.publishedTime) ??
    readableTimestamp(manifest?.createdAt) ??
    readableTimestamp(manifest?.publishedTime) ??
    readableTimestamp(RELEASE_BUILD_CREATED_AT) ??
    "Unavailable";

  let clientType: BuildIdentity["clientType"] = "Published build";
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    clientType = "Expo Go";
  } else if (__DEV__) {
    clientType = "Development preview";
  }

  return {
    appVersion: Constants.expoConfig?.version ?? "Unavailable",
    createdAt,
    runtimeVersion:
      Constants.expoRuntimeVersion ??
      Constants.expoConfig?.runtimeVersion?.toString() ??
      Constants.expoConfig?.sdkVersion ??
      "Unavailable",
    clientType,
    buildId: RELEASE_SENTRY_BUILD_ID ?? "Unavailable",
  };
}