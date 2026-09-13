import * as Sentry from "@sentry/react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";

import {
  RELEASE_CRASH_REPORTING_BUILD_EVIDENCE,
  RELEASE_SENTRY_DIST,
  RELEASE_SENTRY_RELEASE,
} from "@/constants/releaseCrashReporting";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export const sentryEnabled = Boolean(dsn) && !isExpoGo;

if (sentryEnabled) {
  Sentry.init({
    dsn,
    enabled: true,
    release: RELEASE_SENTRY_RELEASE,
    dist: RELEASE_SENTRY_DIST,
    sendDefaultPii: false,
  });
}

if (sentryEnabled) {
  Sentry.setTag(
    "mobile_release_crash_reporting_preflight",
    RELEASE_CRASH_REPORTING_BUILD_EVIDENCE,
  );
}

export function captureNativeSourceMapProbe({
  marker,
  platform,
  candidateBuildId,
}: {
  marker: string;
  platform: "ios" | "android";
  candidateBuildId: string;
}): string {
  let eventId = "";
  Sentry.withScope((scope) => {
    scope.setTags({
      mobile_sentry_probe: marker,
      mobile_platform: platform,
      mobile_candidate_build_id: candidateBuildId,
    });
    scope.setContext("mobile_source_map_probe", {
      marker,
      platform,
      candidateBuildId,
      release: RELEASE_SENTRY_RELEASE,
      dist: RELEASE_SENTRY_DIST,
    });

    eventId = Sentry.captureException(createNativeSourceMapProbeError(marker));
  });
  return eventId;
}

function createNativeSourceMapProbeError(marker: string): Error {
  return new Error(`Controlled native JavaScript source-map probe: ${marker}`);
}

export { Sentry };
