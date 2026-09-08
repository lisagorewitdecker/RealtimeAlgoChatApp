import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRoomAccessCapability,
  verifyRoomAccessCapability,
} from "./roomAccess.js";

function createCapability() {
  return createRoomAccessCapability({
    roomId: "secure-room",
    userId: "user-ada",
    username: "Ada",
    avatarEmoji: "👩‍💻",
    purpose: "sandbox",
  });
}

beforeEach(() => {
  process.env["SESSION_SECRET"] = "room-access-test-secret";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("room access capabilities", () => {
  it("rejects a tampered capability", () => {
    const token = createCapability();
    const [payload, signature] = token.split(".");
    const alteredPayload = `${payload.slice(0, -1)}${
      payload.endsWith("A") ? "B" : "A"
    }`;

    expect(verifyRoomAccessCapability(`${alteredPayload}.${signature}`)).toBeNull();
  });

  it("rejects a capability after its short-lived access window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T17:00:00Z"));
    const token = createCapability();

    vi.advanceTimersByTime(2 * 60 * 1000 + 1);

    expect(verifyRoomAccessCapability(token)).toBeNull();
  });
});