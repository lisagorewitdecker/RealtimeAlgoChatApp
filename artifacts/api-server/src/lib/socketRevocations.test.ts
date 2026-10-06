import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockPool = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: mockPool,
}));

vi.mock("./logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  publishSocketRevocation,
  startSocketRevocationListener,
} from "./socketRevocations.js";

let stopListener: (() => void) | undefined;

afterEach(() => {
  stopListener?.();
  stopListener = undefined;
  mockPool.connect.mockReset();
  mockPool.query.mockReset();
  vi.useRealTimers();
});

describe("socket revocation notifications", () => {
  it("publishes parameterized revocation events", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await publishSocketRevocation({
      type: "account-ban",
      userId: "user-banned",
    });

    expect(mockPool.query).toHaveBeenCalledWith(
      "SELECT pg_notify($1, $2)",
      [
        "realtimealgo_socket_revocations",
        expect.stringContaining('"type":"account-ban"'),
      ],
    );
    expect(mockPool.query.mock.calls[0]?.[1]?.[1]).toContain(
      '"userId":"user-banned"',
    );
  });

  it("waits for LISTEN and handles only valid notifications from other instances", async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    });
    mockPool.connect.mockImplementation(
      (callback: (error: Error | null, client: unknown) => void) => {
        callback(null, client);
      },
    );
    const onRevocation = vi.fn();
    const onUnavailable = vi.fn();
    const listener = startSocketRevocationListener(onRevocation, onUnavailable);
    stopListener = listener.close;

    await listener.waitUntilReady();
    expect(client.query).toHaveBeenCalledWith(
      "LISTEN realtimealgo_socket_revocations",
    );

    client.emit("notification", {
      channel: "realtimealgo_socket_revocations",
      payload: JSON.stringify({
        type: "room-revocation",
        roomId: "room-123",
        userId: "user-banned",
        banned: true,
        source: "another-instance",
      }),
    });
    client.emit("notification", {
      channel: "another-channel",
      payload: JSON.stringify({
        type: "account-ban",
        userId: "user-banned",
        source: "another-instance",
      }),
    });
    client.emit("notification", {
      channel: "realtimealgo_socket_revocations",
      payload: JSON.stringify({
        type: "account-ban",
        source: "another-instance",
      }),
    });

    expect(onRevocation).toHaveBeenCalledExactlyOnceWith({
      type: "room-revocation",
      roomId: "room-123",
      userId: "user-banned",
      banned: true,
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    listener.close();
    await vi.waitFor(() =>
      expect(client.query).toHaveBeenCalledWith(
        "UNLISTEN realtimealgo_socket_revocations",
      ),
    );
    expect(client.release).toHaveBeenCalledOnce();
    stopListener = undefined;
  });

  it("handles a client error during LISTEN only once", async () => {
    vi.useFakeTimers();
    let rejectListen: (error: Error) => void = () => {};
    const listenPromise = new Promise<void>((_resolve, reject) => {
      rejectListen = reject;
    });
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockReturnValue(listenPromise),
      release: vi.fn(),
    });
    mockPool.connect.mockImplementation(
      (callback: (error: Error | null, client: unknown) => void) => {
        callback(null, client);
      },
    );

    const onRevocation = vi.fn();
    const onUnavailable = vi.fn();
    const listener = startSocketRevocationListener(onRevocation, onUnavailable);
    stopListener = listener.close;

    await Promise.resolve();
    expect(client.query).toHaveBeenCalledWith(
      "LISTEN realtimealgo_socket_revocations",
    );
    const error = new Error("connection lost");
    client.emit("error", error);
    rejectListen(error);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.release).toHaveBeenCalledExactlyOnceWith(error);
    expect(client.listenerCount("error")).toBe(0);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
});
