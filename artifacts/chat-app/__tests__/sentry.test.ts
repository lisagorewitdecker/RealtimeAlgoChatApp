const mockInit = jest.fn();

jest.mock("@sentry/react-native", () => ({
  init: mockInit,
  wrap: (component: unknown) => component,
}));

describe("mobile Sentry setup", () => {
  beforeEach(() => {
    jest.resetModules();
    mockInit.mockClear();
  });

  it("initializes error monitoring without sending default PII", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public-dsn.example/123";

    const { sentryEnabled } = require("@/lib/sentry") as {
      sentryEnabled: boolean;
    };

    expect(sentryEnabled).toBe(true);
    expect(mockInit).toHaveBeenCalledWith({
      dsn: "https://public-dsn.example/123",
      enabled: true,
      sendDefaultPii: false,
    });
  });

  it("keeps Sentry disabled when the public runtime DSN is not configured", () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;

    const { sentryEnabled } = require("@/lib/sentry") as {
      sentryEnabled: boolean;
    };

    expect(sentryEnabled).toBe(false);
    expect(mockInit).toHaveBeenCalledWith({
      dsn: undefined,
      enabled: false,
      sendDefaultPii: false,
    });
  });
});