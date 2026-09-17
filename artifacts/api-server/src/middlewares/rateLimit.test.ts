import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIpRateLimit } from "./rateLimit";

function createRequest(): Request {
  return {
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
  } as Request;
}

function createResponse() {
  const response = {
    status: vi.fn(),
    setHeader: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;

  vi.mocked(response.status).mockReturnValue(response);
  vi.mocked(response.setHeader).mockReturnValue(response);
  vi.mocked(response.json).mockReturnValue(response);

  return response;
}

describe("createIpRateLimit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enforces local request caps outside production", () => {
    const rateLimit = createIpRateLimit({
      scope: "test-scope",
      windowMs: 60_000,
      maxRequests: 1,
    });
    const request = createRequest();
    const response = createResponse();
    const next = vi.fn();

    rateLimit(request, response, next);
    rateLimit(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "60");
    expect(response.json).toHaveBeenCalledWith({
      error: "Too many requests. Please try again later.",
    });
  });

  it("skips process-local caps in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    const rateLimit = createIpRateLimit({
      scope: "test-scope",
      windowMs: 60_000,
      maxRequests: 1,
    });
    const request = createRequest();
    const response = createResponse();
    const next = vi.fn();

    rateLimit(request, response, next);
    rateLimit(request, response, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });
});
