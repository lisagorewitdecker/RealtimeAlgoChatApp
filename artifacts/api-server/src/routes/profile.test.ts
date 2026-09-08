import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuth = vi.hoisted(() => vi.fn());
const mockGetAccountProfile = vi.hoisted(() => vi.fn());
const mockUpdateAccountProfile = vi.hoisted(() => vi.fn());
const mockGetAccountAccess = vi.hoisted(() => vi.fn());
const mockIsConfiguredAdmin = vi.hoisted(() => vi.fn());
const mockGetPublicKey = vi.hoisted(() => vi.fn());
const mockSavePublicKey = vi.hoisted(() => vi.fn());

vi.mock("@clerk/express", () => ({
  getAuth: mockGetAuth,
}));

vi.mock("../lib/accountProfile", () => ({
  getAccountProfile: mockGetAccountProfile,
  updateAccountProfile: mockUpdateAccountProfile,
  normalizeProfileUsername: (value: unknown) =>
    typeof value === "string" ? value.trim() : "Member",
  normalizeProfileAvatar: (value: unknown) =>
    typeof value === "string" ? value : "🧑‍💻",
}));

vi.mock("../lib/accountAccess", () => ({
  getAccountAccess: mockGetAccountAccess,
  isConfiguredAdmin: mockIsConfiguredAdmin,
}));

vi.mock("../lib/e2eePersistence", () => ({
  getPublicKey: mockGetPublicKey,
  savePublicKey: mockSavePublicKey,
}));

import profileRouter from "./profile.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", profileRouter);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, "close");
});

beforeEach(() => {
  mockGetAuth.mockReset().mockReturnValue({ userId: "user-ada" });
  mockGetAccountAccess.mockReset().mockResolvedValue({ allowed: true });
  mockIsConfiguredAdmin.mockReset().mockReturnValue(false);
  mockGetPublicKey.mockReset().mockResolvedValue(null);
  mockSavePublicKey.mockReset().mockResolvedValue(undefined);
  mockGetAccountProfile.mockReset().mockResolvedValue({
    username: "Ada",
    avatarEmoji: "👩‍💻",
  });
  mockUpdateAccountProfile.mockReset().mockResolvedValue({
    username: "Ada Lovelace",
    avatarEmoji: "🦄",
  });
});

describe("account profile routes", () => {
  it("returns the account-owned profile for the signed-in user", async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profile: { username: "Ada", avatarEmoji: "👩‍💻" },
      publicKey: null,
      isAdmin: false,
    });
    expect(mockGetAccountProfile).toHaveBeenCalledWith("user-ada");
  });

  it("returns the current account's server-derived administrator flag", async () => {
    mockIsConfiguredAdmin.mockReturnValue(true);

    const response = await fetch(`${baseUrl}/`);

    await expect(response.json()).resolves.toMatchObject({ isAdmin: true });
    expect(mockIsConfiguredAdmin).toHaveBeenCalledWith("user-ada");
  });

  it("writes normalized profile fields for the authenticated account only", async () => {
    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Ada Lovelace", avatarEmoji: "🦄" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profile: { username: "Ada Lovelace", avatarEmoji: "🦄" },
    });
    expect(mockUpdateAccountProfile).toHaveBeenCalledWith("user-ada", {
      username: "Ada Lovelace",
      avatarEmoji: "🦄",
    });
  });

  it("registers and returns a canonical public key without rewriting profile metadata", async () => {
    const publicKey = Buffer.alloc(32, 7).toString("base64");
    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ publicKey });
    expect(mockSavePublicKey).toHaveBeenCalledWith("user-ada", publicKey);
    expect(mockGetAccountProfile).not.toHaveBeenCalled();
    expect(mockUpdateAccountProfile).not.toHaveBeenCalled();
  });

  it("rotates a registered public key to the authenticated account's latest value", async () => {
    const firstKey = Buffer.alloc(32, 1).toString("base64");
    const rotatedKey = Buffer.alloc(32, 2).toString("base64");

    for (const publicKey of [firstKey, rotatedKey]) {
      const response = await fetch(`${baseUrl}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey }),
      });
      expect(response.status).toBe(200);
    }

    expect(mockSavePublicKey.mock.calls).toEqual([
      ["user-ada", firstKey],
      ["user-ada", rotatedKey],
    ]);
  });

  it.each([
    "not-base64",
    Buffer.alloc(31, 1).toString("base64"),
    `${Buffer.alloc(32, 1).toString("base64")}garbage`,
    Buffer.alloc(32, 1).toString("base64").replace(/=$/, ""),
  ])("rejects a malformed public key", async (publicKey) => {
    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey }),
    });

    expect(response.status).toBe(400);
    expect(mockSavePublicKey).not.toHaveBeenCalled();
  });

  it("rejects profile writes without a signed-in account", async () => {
    mockGetAuth.mockReturnValue({ userId: null });

    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Ada" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
    });
    expect(mockUpdateAccountProfile).not.toHaveBeenCalled();
  });

  it("rejects a banned account before loading its profile", async () => {
    mockGetAccountAccess.mockResolvedValue({ allowed: false, reason: "banned" });

    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Your RealtimeAlgoChatApp Studio account has been banned.",
      code: "BANNED",
    });
    expect(mockGetAccountProfile).not.toHaveBeenCalled();
  });
});