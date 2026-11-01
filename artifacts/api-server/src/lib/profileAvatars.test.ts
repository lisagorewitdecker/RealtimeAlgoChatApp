import { readFileSync } from "node:fs";
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

test("accepts every avatar the mobile profile picker offers", () => {
  const pickerSource = readFileSync(
    new URL(
      "../../../chat-app/constants/avatarEmojis.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const pickerList = pickerSource.match(
    /AVATAR_EMOJIS = \[([\s\S]*?)\] as const/,
  )?.[1];
  const pickerAvatars = [...(pickerList ?? "").matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );

  expect(pickerAvatars.length).toBeGreaterThan(0);
  for (const avatar of pickerAvatars) {
    expect(isProfileAvatar(avatar), avatar).toBe(true);
  }
});
