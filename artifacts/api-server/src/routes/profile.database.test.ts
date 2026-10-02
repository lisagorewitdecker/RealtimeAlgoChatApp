import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { db, userProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const userId = `profile-route-concurrency-test-${randomUUID()}`;
const mockGetAuth = vi.hoisted(() => vi.fn(() => ({ userId })));
const mockGetAccountAccess = vi.hoisted(() =>
  vi.fn(async () => ({ allowed: true as const })),
);

vi.mock("@clerk/express", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clerk/express")>();
  return { ...original, getAuth: mockGetAuth };
});

vi.mock("../lib/accountAccess", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/accountAccess")>();
  return { ...original, getAccountAccess: mockGetAccountAccess };
});

import { getPublicKey, getPublicKeyRecord } from "../lib/e2eePersistence.js";
import profileRouter from "./profile.js";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");

let server: Server;
let baseUrl: string;

async function replaceKey(
  publicKey: string,
  previousPublicKey: string | null,
  registrationVersion?: number,
) {
  const response = await fetch(baseUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey,
      previousPublicKey,
      ...(registrationVersion === undefined ? {} : { registrationVersion }),
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required for the profile route concurrency test.");
  }

  const app = express();
  app.use(express.json());
  app.use("/", profileRouter);
  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

beforeEach(async () => {
  await db.delete(userProfilesTable).where(eq(userProfilesTable.userId, userId));
});

afterAll(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  await db.delete(userProfilesTable).where(eq(userProfilesTable.userId, userId));
});

describe("profile key replacement through the live HTTP and database boundary", () => {
  it("allows one concurrent reset and prevents displaced-key requests from undoing it", async () => {
    const displacedKey = key(1);
    const initial = await replaceKey(displacedKey, null);
    expect(initial).toEqual({
      status: 200,
      body: { publicKey: displacedKey },
    });

    const candidateKeys = [key(2), key(3), key(4)];
    const results = await Promise.all(
      candidateKeys.map((candidateKey) => replaceKey(candidateKey, displacedKey)),
    );

    const winners = results.filter((result) => result.status === 200);
    const losers = results.filter((result) => result.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(candidateKeys.length - 1);

    const winningKey = winners[0]?.body["publicKey"];
    expect(candidateKeys).toContain(winningKey);
    for (const loser of losers) {
      expect(loser.body).toEqual({
        error: expect.stringContaining("different encryption key"),
        code: "PUBLIC_KEY_CONFLICT",
        publicKey: winningKey,
      });
    }
    await expect(getPublicKey(userId)).resolves.toBe(winningKey);

    const delayed = await replaceKey(displacedKey, displacedKey);
    expect(delayed).toEqual({
      status: 409,
      body: {
        error: expect.stringContaining("different encryption key"),
        code: "PUBLIC_KEY_CONFLICT",
        publicKey: winningKey,
      },
    });
    await expect(getPublicKey(userId)).resolves.toBe(winningKey);
    expect(mockGetAuth).toHaveBeenCalled();
    expect(mockGetAccountAccess).toHaveBeenCalledWith(userId);
  });

  it("lets only the next registration revision win against concurrent stale and future writes", async () => {
    const initialKey = key(5);
    const winningKey = key(6);
    const staleKey = key(7);
    const futureKey = key(8);
    const initial = await replaceKey(initialKey, null, 1);
    expect(initial).toEqual({
      status: 200,
      body: { publicKey: initialKey, registrationVersion: 1 },
    });

    const [winner, stale, future] = await Promise.all([
      replaceKey(winningKey, initialKey, 2),
      replaceKey(staleKey, initialKey, 1),
      replaceKey(futureKey, initialKey, 4),
    ]);

    expect(winner).toEqual({
      status: 200,
      body: { publicKey: winningKey, registrationVersion: 2 },
    });
    expect(stale).toEqual({
      status: 409,
      body: {
        error: expect.stringContaining("older"),
        code: "PUBLIC_KEY_STALE",
        publicKey: expect.any(String),
        registrationVersion: expect.any(Number),
      },
    });
    expect(future).toEqual({
      status: 409,
      body: {
        error: expect.stringContaining("ahead"),
        code: "PUBLIC_KEY_VERSION_AHEAD",
        publicKey: expect.any(String),
        registrationVersion: expect.any(Number),
      },
    });
    for (const rejected of [stale, future]) {
      expect([
        { publicKey: initialKey, registrationVersion: 1 },
        { publicKey: winningKey, registrationVersion: 2 },
      ]).toContainEqual({
        publicKey: rejected.body["publicKey"],
        registrationVersion: rejected.body["registrationVersion"],
      });
    }
    await expect(getPublicKeyRecord(userId)).resolves.toEqual({
      publicKey: winningKey,
      previousPublicKey: initialKey,
      registrationVersion: 2,
    });
  });
});
