import * as Sentry from "@sentry/react-native";

import { RELEASE_CRASH_REPORTING_BUILD_EVIDENCE } from "@/constants/releaseCrashReporting";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export const sentryEnabled = Boolean(dsn);

Sentry.init({
  dsn,
  enabled: sentryEnabled,
  sendDefaultPii: false,
});

if (sentryEnabled) {
  Sentry.setTag(
    "mobile_release_crash_reporting_preflight",
    RELEASE_CRASH_REPORTING_BUILD_EVIDENCE,
  );
}

export { Sentry };
