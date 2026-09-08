import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuth = vi.hoisted(() => vi.fn());
const mockGetRooms = vi.hoisted(() => vi.fn());
const mockGetAccountProfile = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  getAuth: mockGetAuth,
}));

vi.mock("../socket", () => ({
  getRooms: mockGetRooms,
}));

vi.mock("../lib/accountProfile", () => ({
  getAccountProfile: mockGetAccountProfile,
}));

vi.mock("../lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
}));

import roomsRouter from "./rooms.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use("/", roomsRouter);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  mockGetAuth.mockReset();
  mockGetRooms.mockReset();
  mockGetAccountProfile.mockReset().mockResolvedValue({
    username: "Ada Server",
    avatarEmoji: "👩‍💻",
  });
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
});

describe("GET /api/rooms route", () => {
  it("returns the current rooms for an authenticated user", async () => {
    const rooms = [
      {
        id: "room-alpha",
        name: "Alpha",
        userCount: 2,
        createdAt: 1_700_000_000_000,
      },
    ];
    mockGetAuth.mockReturnValue({ userId: "user-ada" });
    mockGetRooms.mockReturnValue(rooms);

    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rooms });
    expect(mockGetRooms).toHaveBeenCalledOnce();
  });

  it("rejects an unauthenticated room list request", async () => {
    mockGetAuth.mockReturnValue({ userId: null });

    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
    });
    expect(mockGetRooms).not.toHaveBeenCalled();
  });

  it("rejects an unverified account from the room list", async () => {
    mockGetAuth.mockReturnValue({ userId: "user-ada" });
    mockGetAccountAccess.mockResolvedValue({
      allowed: false,
      reason: "unverified",
    });

    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Verify your email before entering RealtimeAlgoChatApp Studio.",
      code: "EMAIL_UNVERIFIED",
    });
    expect(mockGetRooms).not.toHaveBeenCalled();
  });

  it.each(["call", "sandbox"])(
    "uses the account profile for the %s room document, not client headers",
    async (purpose) => {
      mockGetAuth.mockReturnValue({ userId: "user-ada" });

      const response = await fetch(
        `${baseUrl}/${purpose}?roomId=identity-room`,
        {
          headers: {
            "X-DevStudio-Display-Name": "Imposter",
            "X-DevStudio-Avatar-Emoji": "untrusted-avatar",
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Ada Server");
      expect(mockGetAccountProfile).toHaveBeenCalledWith("user-ada");
    },
  );
});