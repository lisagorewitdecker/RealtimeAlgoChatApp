export const PROFILE_AVATARS = [
  "🧑‍💻",
  "🚀",
  "🦊",
  "🐼",
  "🐸",
  "🐙",
  "🦄",
  "🌻",
  "🍕",
  "🎮",
  "🔥",
  "💎",
] as const;

export type ProfileAvatar = (typeof PROFILE_AVATARS)[number];

const profileAvatarSet = new Set<string>(PROFILE_AVATARS);

export function isProfileAvatar(value: unknown): value is ProfileAvatar {
  return typeof value === "string" && profileAvatarSet.has(value);
}