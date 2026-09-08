import { expect, test } from "vitest";
import {
  PROFILE_AVATARS,
  isProfileAvatar,
} from "./profileAvatars";

test("accepts every avatar offered by the profile picker", () => {
  for (const avatar of PROFILE_AVATARS) {
    expect(isProfileAvatar(avatar)).toBe(true);
  }
});

test("rejects arbitrary, empty, and oversized avatar values", () => {
  const invalidValues: unknown[] = [
    "",
    "not-an-emoji",
    "🙂",
    "🚀🚀",
    "🚀".repeat(100),
    42,
    null,
    undefined,
    {},
  ];

  for (const value of invalidValues) {
    expect(isProfileAvatar(value)).toBe(false);
  }
});