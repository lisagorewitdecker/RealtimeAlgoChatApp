import * as Sentry from "@sentry/react-native";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

export const sentryEnabled = Boolean(dsn);

Sentry.init({
  dsn,
  enabled: sentryEnabled,
  sendDefaultPii: false,
});

export { Sentry };