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
    expect(client.release).toHaveBeenCalledOnce();
    stopListener = undefined;
  });
});
