import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureMessage = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const sentryState = vi.hoisted(() => ({ enabled: true }));

vi.mock("./sentry", () => ({
  Sentry: {
    captureMessage: mockCaptureMessage,
    captureException: mockCaptureException,
  },
  get sentryEnabled() {
    return sentryState.enabled;
  },
}));

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: mockLoggerWarn },
}));

const TUNING_ENV_KEYS = [
  "SOCKET_AUTH_FAILURE_ALERT_WINDOW_MS",
  "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD",
  "SOCKET_AUTH_FAILURE_ALERT_COOLDOWN_MS",
  "SOCKET_DISCONNECT_ALERT_WINDOW_MS",
  "SOCKET_DISCONNECT_ALERT_THRESHOLD",
  "SOCKET_DISCONNECT_ALERT_COOLDOWN_MS",
];

describe("socket monitoring", () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockCaptureMessage.mockReset();
    mockCaptureException.mockReset();
    mockLoggerWarn.mockReset();
    sentryState.enabled = true;
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
  });

  it("does not alert on auth failures below the threshold", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("alerts once auth failures cross the threshold within the window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO auth-failure rate",
    );
  });

  it("does not spam an alert for every subsequent failure during the cooldown", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    // Still within the cooldown window -- more failures should not re-alert.
    now += 60_000;
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("alerts again once the cooldown has elapsed and the threshold is crossed again", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    now += 6 * 60_000; // past the 5 minute cooldown
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it("drops occurrences that fall outside the rolling window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    now += 61_000; // outside the 60s window -- old failures should expire
    recordSocketAuthFailure("invalid_session");
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("tracks disconnects on a separate counter from auth failures", async () => {
    const { recordSocketAuthFailure, recordSocketDisconnect } = await import(
      "./socketMonitoring.js"
    );
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    for (let i = 0; i < 29; i += 1) {
      recordSocketDisconnect("transport close");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    recordSocketDisconnect("transport close");
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO disconnect rate",
    );
  });

  it("does not call Sentry when it is disabled, but still logs", async () => {
    sentryState.enabled = false;
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports handler crashes to Sentry with the event name tagged", async () => {
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    const error = new Error("boom");
    reportSocketHandlerError("join-room", error, { sid: "abc" });
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { socketEvent: "join-room" } }),
    );
  });

  it("does not report handler crashes to Sentry when it is disabled", async () => {
    sentryState.enabled = false;
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    reportSocketHandlerError("join-room", new Error("boom"));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  describe("environment-driven tuning", () => {
    it("honors an overridden auth-failure threshold instead of the default", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "3";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      recordSocketAuthFailure("invalid_session");
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it("honors an overridden disconnect window instead of the default", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_WINDOW_MS"] = "5000";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      now += 5_001; // just past the overridden 5s window -- earlier ones expire
      recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("falls back to the default and warns when the override is not a positive number", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "not-a-number";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      for (let i = 0; i < 9; i += 1) {
        recordSocketAuthFailure("invalid_session");
      }
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session"); // 10th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ name: "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD" }),
        expect.stringContaining("SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"),
      );
    });

    it("falls back to the default when the override is zero or negative", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_THRESHOLD"] = "0";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketDisconnect("transport close"); // 30th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureMessage = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const sentryState = vi.hoisted(() => ({ enabled: true }));

vi.mock("./sentry", () => ({
  Sentry: {
    captureMessage: mockCaptureMessage,
    captureException: mockCaptureException,
  },
  get sentryEnabled() {
    return sentryState.enabled;
  },
}));

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: mockLoggerWarn },
}));

const TUNING_ENV_KEYS = [
  "SOCKET_AUTH_FAILURE_ALERT_WINDOW_MS",
  "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD",
  "SOCKET_AUTH_FAILURE_ALERT_COOLDOWN_MS",
  "SOCKET_DISCONNECT_ALERT_WINDOW_MS",
  "SOCKET_DISCONNECT_ALERT_THRESHOLD",
  "SOCKET_DISCONNECT_ALERT_COOLDOWN_MS",
];

describe("socket monitoring", () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockCaptureMessage.mockReset();
    mockCaptureException.mockReset();
    mockLoggerWarn.mockReset();
    sentryState.enabled = true;
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
  });

  it("does not alert on auth failures below the threshold", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("alerts once auth failures cross the threshold within the window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO auth-failure rate",
    );
  });

  it("does not spam an alert for every subsequent failure during the cooldown", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    // Still within the cooldown window -- more failures should not re-alert.
    now += 60_000;
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("alerts again once the cooldown has elapsed and the threshold is crossed again", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    now += 6 * 60_000; // past the 5 minute cooldown
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it("drops occurrences that fall outside the rolling window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    now += 61_000; // outside the 60s window -- old failures should expire
    recordSocketAuthFailure("invalid_session");
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("tracks disconnects on a separate counter from auth failures", async () => {
    const { recordSocketAuthFailure, recordSocketDisconnect } = await import(
      "./socketMonitoring.js"
    );
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    for (let i = 0; i < 29; i += 1) {
      recordSocketDisconnect("transport close");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    recordSocketDisconnect("transport close");
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO disconnect rate",
    );
  });

  it("does not call Sentry when it is disabled, but still logs", async () => {
    sentryState.enabled = false;
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports handler crashes to Sentry with the event name tagged", async () => {
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    const error = new Error("boom");
    reportSocketHandlerError("join-room", error, { sid: "abc" });
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { socketEvent: "join-room" } }),
    );
  });

  it("does not report handler crashes to Sentry when it is disabled", async () => {
    sentryState.enabled = false;
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    reportSocketHandlerError("join-room", new Error("boom"));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  describe("environment-driven tuning", () => {
    it("honors an overridden auth-failure threshold instead of the default", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "3";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      recordSocketAuthFailure("invalid_session");
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it("honors an overridden disconnect window instead of the default", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_WINDOW_MS"] = "5000";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      now += 5_001; // just past the overridden 5s window -- earlier ones expire
      recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("falls back to the default and warns when the override is not a positive number", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "not-a-number";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      for (let i = 0; i < 9; i += 1) {
        recordSocketAuthFailure("invalid_session");
      }
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session"); // 10th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ name: "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD" }),
        expect.stringContaining("SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"),
      );
    });

    it("falls back to the default when the override is zero or negative", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_THRESHOLD"] = "0";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketDisconnect("transport close"); // 30th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureMessage = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const sentryState = vi.hoisted(() => ({ enabled: true }));

vi.mock("./sentry", () => ({
  Sentry: {
    captureMessage: mockCaptureMessage,
    captureException: mockCaptureException,
  },
  get sentryEnabled() {
    return sentryState.enabled;
  },
}));

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: mockLoggerWarn },
}));

const TUNING_ENV_KEYS = [
  "SOCKET_AUTH_FAILURE_ALERT_WINDOW_MS",
  "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD",
  "SOCKET_AUTH_FAILURE_ALERT_COOLDOWN_MS",
  "SOCKET_DISCONNECT_ALERT_WINDOW_MS",
  "SOCKET_DISCONNECT_ALERT_THRESHOLD",
  "SOCKET_DISCONNECT_ALERT_COOLDOWN_MS",
];

describe("socket monitoring", () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockCaptureMessage.mockReset();
    mockCaptureException.mockReset();
    mockLoggerWarn.mockReset();
    sentryState.enabled = true;
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
  });

  it("does not alert on auth failures below the threshold", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("alerts once auth failures cross the threshold within the window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO auth-failure rate",
    );
  });

  it("does not spam an alert for every subsequent failure during the cooldown", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    // Still within the cooldown window -- more failures should not re-alert.
    now += 60_000;
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("alerts again once the cooldown has elapsed and the threshold is crossed again", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    now += 6 * 60_000; // past the 5 minute cooldown
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it("drops occurrences that fall outside the rolling window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    now += 61_000; // outside the 60s window -- old failures should expire
    recordSocketAuthFailure("invalid_session");
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("tracks disconnects on a separate counter from auth failures", async () => {
    const { recordSocketAuthFailure, recordSocketDisconnect } = await import(
      "./socketMonitoring.js"
    );
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    for (let i = 0; i < 29; i += 1) {
      recordSocketDisconnect("transport close");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    recordSocketDisconnect("transport close");
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO disconnect rate",
    );
  });

  it("does not call Sentry when it is disabled, but still logs", async () => {
    sentryState.enabled = false;
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports handler crashes to Sentry with the event name tagged", async () => {
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    const error = new Error("boom");
    reportSocketHandlerError("join-room", error, { sid: "abc" });
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { socketEvent: "join-room" } }),
    );
  });

  it("does not report handler crashes to Sentry when it is disabled", async () => {
    sentryState.enabled = false;
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    reportSocketHandlerError("join-room", new Error("boom"));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  describe("environment-driven tuning", () => {
    it("honors an overridden auth-failure threshold instead of the default", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "3";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      recordSocketAuthFailure("invalid_session");
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it("honors an overridden disconnect window instead of the default", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_WINDOW_MS"] = "5000";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      now += 5_001; // just past the overridden 5s window -- earlier ones expire
      recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("falls back to the default and warns when the override is not a positive number", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "not-a-number";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      for (let i = 0; i < 9; i += 1) {
        recordSocketAuthFailure("invalid_session");
      }
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session"); // 10th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ name: "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD" }),
        expect.stringContaining("SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"),
      );
    });

    it("falls back to the default when the override is zero or negative", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_THRESHOLD"] = "0";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketDisconnect("transport close"); // 30th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });
  });
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureMessage = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const sentryState = vi.hoisted(() => ({ enabled: true }));

vi.mock("./sentry", () => ({
  Sentry: {
    captureMessage: mockCaptureMessage,
    captureException: mockCaptureException,
  },
  get sentryEnabled() {
    return sentryState.enabled;
  },
}));

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: mockLoggerWarn },
}));

const TUNING_ENV_KEYS = [
  "SOCKET_AUTH_FAILURE_ALERT_WINDOW_MS",
  "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD",
  "SOCKET_AUTH_FAILURE_ALERT_COOLDOWN_MS",
  "SOCKET_DISCONNECT_ALERT_WINDOW_MS",
  "SOCKET_DISCONNECT_ALERT_THRESHOLD",
  "SOCKET_DISCONNECT_ALERT_COOLDOWN_MS",
];

describe("socket monitoring", () => {
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockCaptureMessage.mockReset();
    mockCaptureException.mockReset();
    mockLoggerWarn.mockReset();
    sentryState.enabled = true;
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of TUNING_ENV_KEYS) delete process.env[key];
    vi.restoreAllMocks();
  });

  it("does not alert on auth failures below the threshold", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("alerts once auth failures cross the threshold within the window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO auth-failure rate",
    );
  });

  it("does not spam an alert for every subsequent failure during the cooldown", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    // Still within the cooldown window -- more failures should not re-alert.
    now += 60_000;
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it("alerts again once the cooldown has elapsed and the threshold is crossed again", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);

    now += 6 * 60_000; // past the 5 minute cooldown
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(2);
  });

  it("drops occurrences that fall outside the rolling window", async () => {
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    now += 61_000; // outside the 60s window -- old failures should expire
    recordSocketAuthFailure("invalid_session");
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("tracks disconnects on a separate counter from auth failures", async () => {
    const { recordSocketAuthFailure, recordSocketDisconnect } = await import(
      "./socketMonitoring.js"
    );
    for (let i = 0; i < 9; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    for (let i = 0; i < 29; i += 1) {
      recordSocketDisconnect("transport close");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    recordSocketDisconnect("transport close");
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0]![0]).toContain(
      "Elevated Socket.IO disconnect rate",
    );
  });

  it("does not call Sentry when it is disabled, but still logs", async () => {
    sentryState.enabled = false;
    const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
    for (let i = 0; i < 10; i += 1) {
      recordSocketAuthFailure("invalid_session");
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("reports handler crashes to Sentry with the event name tagged", async () => {
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    const error = new Error("boom");
    reportSocketHandlerError("join-room", error, { sid: "abc" });
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { socketEvent: "join-room" } }),
    );
  });

  it("does not report handler crashes to Sentry when it is disabled", async () => {
    sentryState.enabled = false;
    const { reportSocketHandlerError } = await import("./socketMonitoring.js");
    reportSocketHandlerError("join-room", new Error("boom"));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  describe("environment-driven tuning", () => {
    it("honors an overridden auth-failure threshold instead of the default", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "3";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      recordSocketAuthFailure("invalid_session");
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session");
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it("honors an overridden disconnect window instead of the default", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_WINDOW_MS"] = "5000";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      now += 5_001; // just past the overridden 5s window -- earlier ones expire
      recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("falls back to the default and warns when the override is not a positive number", async () => {
      process.env["SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"] = "not-a-number";
      const { recordSocketAuthFailure } = await import("./socketMonitoring.js");
      for (let i = 0; i < 9; i += 1) {
        recordSocketAuthFailure("invalid_session");
      }
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketAuthFailure("invalid_session"); // 10th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ name: "SOCKET_AUTH_FAILURE_ALERT_THRESHOLD" }),
        expect.stringContaining("SOCKET_AUTH_FAILURE_ALERT_THRESHOLD"),
      );
    });

    it("falls back to the default when the override is zero or negative", async () => {
      process.env["SOCKET_DISCONNECT_ALERT_THRESHOLD"] = "0";
      const { recordSocketDisconnect } = await import("./socketMonitoring.js");
      for (let i = 0; i < 29; i += 1) recordSocketDisconnect("transport close");
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      recordSocketDisconnect("transport close"); // 30th -- the default threshold
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });
  });
});
