import * as Sentry from "@sentry/node";

const dsn = process.env["SENTRY_DSN"];

export const sentryEnabled = Boolean(dsn);

export { Sentry };
