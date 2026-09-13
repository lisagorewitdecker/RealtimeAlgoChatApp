const mockInit = jest.fn();
const mockSetTag = jest.fn();
const mockSetTags = jest.fn();
const mockSetContext = jest.fn();
const mockCaptureException = jest.fn((_error: Error) => "event-id");

jest.mock("@sentry/react-native", () => ({
  init: mockInit,
  setTag: mockSetTag,
  captureException: mockCaptureException,
  withScope: (callback: (scope: unknown) => unknown) =>
    callback({
      setTags: mockSetTags,
      setContext: mockSetContext,
    }),
  wrap: (component: unknown) => component,
}));

describe("mobile Sentry setup", () => {
  beforeEach(() => {
    jest.resetModules();
    mockInit.mockClear();
    mockSetTag.mockClear();
    mockSetTags.mockClear();
    mockSetContext.mockClear();
    mockCaptureException.mockClear();
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
      release: undefined,
      dist: undefined,
      sendDefaultPii: false,
    });
  });

  it("keeps Sentry disabled when the public runtime DSN is not configured", () => {
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;

    const { sentryEnabled } = require("@/lib/sentry") as {
      sentryEnabled: boolean;
    };

    expect(sentryEnabled).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("does not initialize native Sentry inside Expo Go", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public-dsn.example/123";
    jest.doMock("expo-constants", () => ({
      __esModule: true,
      default: { executionEnvironment: "storeClient" },
      ExecutionEnvironment: { StoreClient: "storeClient" },
    }));

    const { sentryEnabled } = require("@/lib/sentry") as {
      sentryEnabled: boolean;
    };

    expect(sentryEnabled).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("captures a controlled native probe with candidate-bound tags", () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public-dsn.example/123";

    const { captureNativeSourceMapProbe } = require("@/lib/sentry") as {
      captureNativeSourceMapProbe: (input: {
        marker: string;
        platform: "ios" | "android";
        candidateBuildId: string;
      }) => string;
    };

    expect(
      captureNativeSourceMapProbe({
        marker: "run-1234-ios",
        platform: "ios",
        candidateBuildId: "build-ios",
      }),
    ).toBe("event-id");
    expect(mockSetTags).toHaveBeenCalledWith({
      mobile_sentry_probe: "run-1234-ios",
      mobile_platform: "ios",
      mobile_candidate_build_id: "build-ios",
    });
    expect(mockCaptureException.mock.calls[0]?.[0]).toMatchObject({
      message: "Controlled native JavaScript source-map probe: run-1234-ios",
    });
    expect(mockCaptureException.mock.calls[0]?.[0]?.stack).toContain(
      "createNativeSourceMapProbeError",
    );
  });
});