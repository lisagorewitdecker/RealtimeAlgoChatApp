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
const mockGetPublicKeyRecord = vi.hoisted(() => vi.fn());
const mockRegisterPublicKey = vi.hoisted(() => vi.fn());

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
  getPublicKeyRecord: mockGetPublicKeyRecord,
  registerPublicKey: mockRegisterPublicKey,
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
  mockGetPublicKeyRecord.mockReset().mockResolvedValue({
    publicKey: null,
    previousPublicKey: null,
    registrationVersion: null,
  });
  mockRegisterPublicKey
    .mockReset()
    .mockImplementation(async (_userId: string, publicKey: string) => ({
      outcome: "registered",
      publicKey,
    }));
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
    expect(response.headers.get("cache-control")).toBe("no-store");
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

  it("does not cache the administrator profile response", async () => {
    mockIsConfiguredAdmin.mockReturnValue(true);

    const response = await fetch(`${baseUrl}/`, {
      headers: { "If-None-Match": "\"stale-profile\"" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ isAdmin: true });
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
    // Without previousPublicKey the write may only fill an empty slot or
    // re-send the same key: the persistence layer receives `null` to compare.
    expect(mockRegisterPublicKey).toHaveBeenCalledWith("user-ada", publicKey, null);
    expect(mockGetAccountProfile).not.toHaveBeenCalled();
    expect(mockUpdateAccountProfile).not.toHaveBeenCalled();
  });

  it("replaces a registered key only when the request names the key it replaces", async () => {
    const firstKey = Buffer.alloc(32, 1).toString("base64");
    const rotatedKey = Buffer.alloc(32, 2).toString("base64");

    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: rotatedKey, previousPublicKey: firstKey }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ publicKey: rotatedKey });
    expect(mockRegisterPublicKey).toHaveBeenCalledWith("user-ada", rotatedKey, firstKey);
  });

  it("passes a registration version and reports a stale write without changing the key", async () => {
    const publicKey = Buffer.alloc(32, 1).toString("base64");
    const registeredPublicKey = Buffer.alloc(32, 2).toString("base64");
    mockRegisterPublicKey.mockResolvedValue({
      outcome: "stale",
      registeredPublicKey,
      registrationVersion: 3,
    });

    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey,
        previousPublicKey: registeredPublicKey,
        registrationVersion: 4,
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("older"),
      code: "PUBLIC_KEY_STALE",
      publicKey: registeredPublicKey,
      registrationVersion: 3,
    });
    expect(mockRegisterPublicKey).toHaveBeenCalledWith(
      "user-ada",
      publicKey,
      registeredPublicKey,
      4,
    );
    expect(mockUpdateAccountProfile).not.toHaveBeenCalled();
  });

  it.each([0, 2, Number.MAX_SAFE_INTEGER])(
    "returns PUBLIC_KEY_VERSION_AHEAD for an invalid empty-account revision %s",
    async (registrationVersion) => {
      const publicKey = Buffer.alloc(32, 4).toString("base64");
      mockRegisterPublicKey.mockResolvedValue({
        outcome: "future",
        registeredPublicKey: null,
        registrationVersion: null,
      });

      const response = await fetch(`${baseUrl}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey, registrationVersion }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining("ahead"),
        code: "PUBLIC_KEY_VERSION_AHEAD",
        publicKey: null,
        registrationVersion: null,
      });
      expect(mockRegisterPublicKey).toHaveBeenCalledWith(
        "user-ada",
        publicKey,
        null,
        registrationVersion,
      );
    },
  );

  it("refuses to overwrite a different registered key and reports the key it kept", async () => {
    const resetKey = Buffer.alloc(32, 2).toString("base64");
    const staleKey = Buffer.alloc(32, 1).toString("base64");
    mockRegisterPublicKey.mockResolvedValue({
      outcome: "conflict",
      registeredPublicKey: resetKey,
    });

    // A delayed re-registration from an older device or session names no
    // previous key (or the wrong one) and must not undo the reset.
    for (const body of [
      { publicKey: staleKey },
      { publicKey: staleKey, previousPublicKey: Buffer.alloc(32, 3).toString("base64") },
      { publicKey: staleKey, previousPublicKey: null },
    ]) {
      const response = await fetch(`${baseUrl}/`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining("different encryption key"),
        code: "PUBLIC_KEY_CONFLICT",
        publicKey: resetKey,
      });
    }
    expect(mockRegisterPublicKey.mock.calls).toEqual([
      ["user-ada", staleKey, null],
      ["user-ada", staleKey, Buffer.alloc(32, 3).toString("base64")],
      ["user-ada", staleKey, null],
    ]);
  });

  it("does not touch profile metadata when a combined write loses the key conflict", async () => {
    const publicKey = Buffer.alloc(32, 1).toString("base64");
    mockRegisterPublicKey.mockResolvedValue({
      outcome: "conflict",
      registeredPublicKey: Buffer.alloc(32, 2).toString("base64"),
    });

    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Ada Lovelace", publicKey }),
    });

    expect(response.status).toBe(409);
    expect(mockUpdateAccountProfile).not.toHaveBeenCalled();
  });

  it("registers the key and updates metadata in one combined write", async () => {
    const publicKey = Buffer.alloc(32, 1).toString("base64");

    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Ada Lovelace", avatarEmoji: "🦄", publicKey }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profile: { username: "Ada Lovelace", avatarEmoji: "🦄" },
      publicKey,
    });
    expect(mockRegisterPublicKey).toHaveBeenCalledWith("user-ada", publicKey, null);
    expect(mockUpdateAccountProfile).toHaveBeenCalledWith("user-ada", {
      username: "Ada Lovelace",
      avatarEmoji: "🦄",
    });
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
    expect(mockRegisterPublicKey).not.toHaveBeenCalled();
  });

  it.each([
    { publicKey: Buffer.alloc(32, 1).toString("base64"), previousPublicKey: "not-base64" },
    { publicKey: Buffer.alloc(32, 1).toString("base64"), previousPublicKey: 42 },
    { previousPublicKey: Buffer.alloc(32, 1).toString("base64") },
  ])("rejects a malformed or dangling previousPublicKey %j", async (body) => {
    const response = await fetch(`${baseUrl}/`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(mockRegisterPublicKey).not.toHaveBeenCalled();
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