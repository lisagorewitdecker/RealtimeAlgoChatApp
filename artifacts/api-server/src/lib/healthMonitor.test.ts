import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() => vi.fn());
const mockWithMonitor = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./sentry", () => ({
  Sentry: {
    captureException: mockCaptureException,
    withMonitor: mockWithMonitor,
  },
  sentryEnabled: true,
}));

vi.mock("./logger", () => ({
  logger: {
    error: mockLoggerError,
    warn: mockLoggerWarn,
  },
}));

import {
  parseReadinessFailureBody,
  pingHealthz,
  startHealthMonitor,
} from "./healthMonitor.js";

function responseWithBody(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockWithMonitor.mockReset();
  mockCaptureException.mockReset();
  mockLoggerError.mockReset();
  mockLoggerWarn.mockReset();
  mockWithMonitor.mockImplementation(
    async (_slug: string, callback: () => Promise<void>) => callback(),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseReadinessFailureBody", () => {
  it("keeps only the allowlisted reason and bounded elapsed time", () => {
    expect(
      parseReadinessFailureBody({
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        databaseUrl: "postgres://user:password@example.invalid/db",
      }),
    ).toEqual({ reason: "connection", elapsedMs: 321 });
  });

  it.each([
    ["a non-object body", null],
    ["an unrecognized reason", { reason: "database-password", elapsedMs: 321 }],
    ["a string elapsed time", { reason: "timeout", elapsedMs: "321" }],
    ["a negative elapsed time", { reason: "timeout", elapsedMs: -1 }],
    ["a fractional elapsed time", { reason: "timeout", elapsedMs: 1.5 }],
    ["an overlong elapsed time", { reason: "timeout", elapsedMs: 60_001 }],
  ])("rejects %s without retaining response details", (_label, body) => {
    expect(parseReadinessFailureBody(body)).toBeUndefined();
  });
});

describe("pingHealthz", () => {
  it("reports valid readiness details without including the raw response", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "timeout",
        elapsedMs: 4_321,
        databaseUrl: "postgres://user:password@example.invalid/db",
        detail: "raw database driver output",
      }),
    );

    const error = await pingHealthz(4_321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503 (reason=timeout, elapsedMs=4321)",
    );
    expect((error as Error).message).not.toContain("password");
    expect((error as Error).message).not.toContain("raw database driver output");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/healthz",
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["invalid JSON", () => Promise.reject(new Error("raw database output"))],
    [
      "an invalid failure shape",
      () =>
        Promise.resolve({
          status: "unavailable",
          reason: "raw database output",
          elapsedMs: 321,
        }),
    ],
  ])("uses a generic error for %s without echoing the body", async (_label, json) => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(json),
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503",
    );
    expect((error as Error).message).not.toContain("raw database output");
  });

  it("does not read or echo a body for other HTTP failures", async () => {
    const json = vi.fn().mockResolvedValue({
      reason: "raw database output",
      elapsedMs: 321,
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json,
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 500",
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("startHealthMonitor", () => {
  it("includes valid readiness details in Sentry and server logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
      }),
      {
        tags: { readinessFailureReason: "connection" },
        extra: { elapsedMs: 321 },
      },
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message:
            "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
        }),
        reason: "connection",
        elapsedMs: 321,
      },
      "/api/healthz uptime check failed",
    );
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(
      "do-not-log",
    );
  });

  it("keeps malformed readiness failures generic in Sentry and logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        reason: "raw database output",
        elapsedMs: "321",
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "/api/healthz responded with status 503",
      }),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: "/api/healthz responded with status 503",
        }),
      },
      "/api/healthz uptime check failed",
    );
    const serialized = JSON.stringify([
      mockCaptureException.mock.calls,
      mockLoggerError.mock.calls,
    ]);
    expect(serialized).not.toContain("raw database output");
    expect(serialized).not.toContain("do-not-log");
  });
});import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() => vi.fn());
const mockWithMonitor = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./sentry", () => ({
  Sentry: {
    captureException: mockCaptureException,
    withMonitor: mockWithMonitor,
  },
  sentryEnabled: true,
}));

vi.mock("./logger", () => ({
  logger: {
    error: mockLoggerError,
    warn: mockLoggerWarn,
  },
}));

import {
  parseReadinessFailureBody,
  pingHealthz,
  startHealthMonitor,
} from "./healthMonitor.js";

function responseWithBody(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockWithMonitor.mockReset();
  mockCaptureException.mockReset();
  mockLoggerError.mockReset();
  mockLoggerWarn.mockReset();
  mockWithMonitor.mockImplementation(
    async (_slug: string, callback: () => Promise<void>) => callback(),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseReadinessFailureBody", () => {
  it("keeps only the allowlisted reason and bounded elapsed time", () => {
    expect(
      parseReadinessFailureBody({
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        databaseUrl: "postgres://user:password@example.invalid/db",
      }),
    ).toEqual({ reason: "connection", elapsedMs: 321 });
  });

  it.each([
    ["a non-object body", null],
    ["an unrecognized reason", { reason: "database-password", elapsedMs: 321 }],
    ["a string elapsed time", { reason: "timeout", elapsedMs: "321" }],
    ["a negative elapsed time", { reason: "timeout", elapsedMs: -1 }],
    ["a fractional elapsed time", { reason: "timeout", elapsedMs: 1.5 }],
    ["an overlong elapsed time", { reason: "timeout", elapsedMs: 60_001 }],
  ])("rejects %s without retaining response details", (_label, body) => {
    expect(parseReadinessFailureBody(body)).toBeUndefined();
  });
});

describe("pingHealthz", () => {
  it("reports valid readiness details without including the raw response", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "timeout",
        elapsedMs: 4_321,
        databaseUrl: "postgres://user:password@example.invalid/db",
        detail: "raw database driver output",
      }),
    );

    const error = await pingHealthz(4_321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503 (reason=timeout, elapsedMs=4321)",
    );
    expect((error as Error).message).not.toContain("password");
    expect((error as Error).message).not.toContain("raw database driver output");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/healthz",
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["invalid JSON", () => Promise.reject(new Error("raw database output"))],
    [
      "an invalid failure shape",
      () =>
        Promise.resolve({
          status: "unavailable",
          reason: "raw database output",
          elapsedMs: 321,
        }),
    ],
  ])("uses a generic error for %s without echoing the body", async (_label, json) => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(json),
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503",
    );
    expect((error as Error).message).not.toContain("raw database output");
  });

  it("does not read or echo a body for other HTTP failures", async () => {
    const json = vi.fn().mockResolvedValue({
      reason: "raw database output",
      elapsedMs: 321,
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json,
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 500",
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("startHealthMonitor", () => {
  it("includes valid readiness details in Sentry and server logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
      }),
      {
        tags: { readinessFailureReason: "connection" },
        extra: { elapsedMs: 321 },
      },
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message:
            "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
        }),
        reason: "connection",
        elapsedMs: 321,
      },
      "/api/healthz uptime check failed",
    );
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(
      "do-not-log",
    );
  });

  it("keeps malformed readiness failures generic in Sentry and logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        reason: "raw database output",
        elapsedMs: "321",
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "/api/healthz responded with status 503",
      }),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: "/api/healthz responded with status 503",
        }),
      },
      "/api/healthz uptime check failed",
    );
    const serialized = JSON.stringify([
      mockCaptureException.mock.calls,
      mockLoggerError.mock.calls,
    ]);
    expect(serialized).not.toContain("raw database output");
    expect(serialized).not.toContain("do-not-log");
  });
});import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() => vi.fn());
const mockWithMonitor = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./sentry", () => ({
  Sentry: {
    captureException: mockCaptureException,
    withMonitor: mockWithMonitor,
  },
  sentryEnabled: true,
}));

vi.mock("./logger", () => ({
  logger: {
    error: mockLoggerError,
    warn: mockLoggerWarn,
  },
}));

import {
  parseReadinessFailureBody,
  pingHealthz,
  startHealthMonitor,
} from "./healthMonitor.js";

function responseWithBody(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockWithMonitor.mockReset();
  mockCaptureException.mockReset();
  mockLoggerError.mockReset();
  mockLoggerWarn.mockReset();
  mockWithMonitor.mockImplementation(
    async (_slug: string, callback: () => Promise<void>) => callback(),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseReadinessFailureBody", () => {
  it("keeps only the allowlisted reason and bounded elapsed time", () => {
    expect(
      parseReadinessFailureBody({
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        databaseUrl: "postgres://user:password@example.invalid/db",
      }),
    ).toEqual({ reason: "connection", elapsedMs: 321 });
  });

  it.each([
    ["a non-object body", null],
    ["an unrecognized reason", { reason: "database-password", elapsedMs: 321 }],
    ["a string elapsed time", { reason: "timeout", elapsedMs: "321" }],
    ["a negative elapsed time", { reason: "timeout", elapsedMs: -1 }],
    ["a fractional elapsed time", { reason: "timeout", elapsedMs: 1.5 }],
    ["an overlong elapsed time", { reason: "timeout", elapsedMs: 60_001 }],
  ])("rejects %s without retaining response details", (_label, body) => {
    expect(parseReadinessFailureBody(body)).toBeUndefined();
  });
});

describe("pingHealthz", () => {
  it("reports valid readiness details without including the raw response", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "timeout",
        elapsedMs: 4_321,
        databaseUrl: "postgres://user:password@example.invalid/db",
        detail: "raw database driver output",
      }),
    );

    const error = await pingHealthz(4_321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503 (reason=timeout, elapsedMs=4321)",
    );
    expect((error as Error).message).not.toContain("password");
    expect((error as Error).message).not.toContain("raw database driver output");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/healthz",
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["invalid JSON", () => Promise.reject(new Error("raw database output"))],
    [
      "an invalid failure shape",
      () =>
        Promise.resolve({
          status: "unavailable",
          reason: "raw database output",
          elapsedMs: 321,
        }),
    ],
  ])("uses a generic error for %s without echoing the body", async (_label, json) => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(json),
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503",
    );
    expect((error as Error).message).not.toContain("raw database output");
  });

  it("does not read or echo a body for other HTTP failures", async () => {
    const json = vi.fn().mockResolvedValue({
      reason: "raw database output",
      elapsedMs: 321,
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json,
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 500",
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("startHealthMonitor", () => {
  it("includes valid readiness details in Sentry and server logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
      }),
      {
        tags: { readinessFailureReason: "connection" },
        extra: { elapsedMs: 321 },
      },
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message:
            "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
        }),
        reason: "connection",
        elapsedMs: 321,
      },
      "/api/healthz uptime check failed",
    );
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(
      "do-not-log",
    );
  });

  it("keeps malformed readiness failures generic in Sentry and logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        reason: "raw database output",
        elapsedMs: "321",
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "/api/healthz responded with status 503",
      }),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: "/api/healthz responded with status 503",
        }),
      },
      "/api/healthz uptime check failed",
    );
    const serialized = JSON.stringify([
      mockCaptureException.mock.calls,
      mockLoggerError.mock.calls,
    ]);
    expect(serialized).not.toContain("raw database output");
    expect(serialized).not.toContain("do-not-log");
  });
});import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() => vi.fn());
const mockWithMonitor = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockLoggerError = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("./sentry", () => ({
  Sentry: {
    captureException: mockCaptureException,
    withMonitor: mockWithMonitor,
  },
  sentryEnabled: true,
}));

vi.mock("./logger", () => ({
  logger: {
    error: mockLoggerError,
    warn: mockLoggerWarn,
  },
}));

import {
  parseReadinessFailureBody,
  pingHealthz,
  startHealthMonitor,
} from "./healthMonitor.js";

function responseWithBody(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockWithMonitor.mockReset();
  mockCaptureException.mockReset();
  mockLoggerError.mockReset();
  mockLoggerWarn.mockReset();
  mockWithMonitor.mockImplementation(
    async (_slug: string, callback: () => Promise<void>) => callback(),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseReadinessFailureBody", () => {
  it("keeps only the allowlisted reason and bounded elapsed time", () => {
    expect(
      parseReadinessFailureBody({
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        databaseUrl: "postgres://user:password@example.invalid/db",
      }),
    ).toEqual({ reason: "connection", elapsedMs: 321 });
  });

  it.each([
    ["a non-object body", null],
    ["an unrecognized reason", { reason: "database-password", elapsedMs: 321 }],
    ["a string elapsed time", { reason: "timeout", elapsedMs: "321" }],
    ["a negative elapsed time", { reason: "timeout", elapsedMs: -1 }],
    ["a fractional elapsed time", { reason: "timeout", elapsedMs: 1.5 }],
    ["an overlong elapsed time", { reason: "timeout", elapsedMs: 60_001 }],
  ])("rejects %s without retaining response details", (_label, body) => {
    expect(parseReadinessFailureBody(body)).toBeUndefined();
  });
});

describe("pingHealthz", () => {
  it("reports valid readiness details without including the raw response", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "timeout",
        elapsedMs: 4_321,
        databaseUrl: "postgres://user:password@example.invalid/db",
        detail: "raw database driver output",
      }),
    );

    const error = await pingHealthz(4_321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503 (reason=timeout, elapsedMs=4321)",
    );
    expect((error as Error).message).not.toContain("password");
    expect((error as Error).message).not.toContain("raw database driver output");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/healthz",
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["invalid JSON", () => Promise.reject(new Error("raw database output"))],
    [
      "an invalid failure shape",
      () =>
        Promise.resolve({
          status: "unavailable",
          reason: "raw database output",
          elapsedMs: 321,
        }),
    ],
  ])("uses a generic error for %s without echoing the body", async (_label, json) => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn().mockImplementation(json),
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 503",
    );
    expect((error as Error).message).not.toContain("raw database output");
  });

  it("does not read or echo a body for other HTTP failures", async () => {
    const json = vi.fn().mockResolvedValue({
      reason: "raw database output",
      elapsedMs: 321,
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json,
    } as unknown as Response);

    const error = await pingHealthz(4321).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "/api/healthz responded with status 500",
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("startHealthMonitor", () => {
  it("includes valid readiness details in Sentry and server logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        status: "unavailable",
        reason: "connection",
        elapsedMs: 321,
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
      }),
      {
        tags: { readinessFailureReason: "connection" },
        extra: { elapsedMs: 321 },
      },
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message:
            "/api/healthz responded with status 503 (reason=connection, elapsedMs=321)",
        }),
        reason: "connection",
        elapsedMs: 321,
      },
      "/api/healthz uptime check failed",
    );
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(
      "do-not-log",
    );
  });

  it("keeps malformed readiness failures generic in Sentry and logs", async () => {
    mockFetch.mockResolvedValueOnce(
      responseWithBody(503, {
        reason: "raw database output",
        elapsedMs: "321",
        secret: "do-not-log",
      }),
    );

    startHealthMonitor(4321);
    await vi.waitFor(() => expect(mockLoggerError).toHaveBeenCalledOnce());

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "/api/healthz responded with status 503",
      }),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: "/api/healthz responded with status 503",
        }),
      },
      "/api/healthz uptime check failed",
    );
    const serialized = JSON.stringify([
      mockCaptureException.mock.calls,
      mockLoggerError.mock.calls,
    ]);
    expect(serialized).not.toContain("raw database output");
    expect(serialized).not.toContain("do-not-log");
  });
});