/**
 * Avatars a profile write may set. This must include every choice the mobile
 * profile picker offers (artifacts/chat-app/constants/avatarEmojis.ts); the
 * profileAvatars test checks that.
 */
export const PROFILE_AVATARS = [
  "😀",
  "😎",
  "🤓",
  "🧑‍💻",
  "👩‍💻",
  "👨‍💻",
  "🦄",
  "🐱",
  "🐶",
  "🦊",
  "🐼",
  "🐸",
  "🐙",
  "🦋",
  "🌈",
  "🔥",
  "⚡",
  "🚀",
  "🎨",
  "🎮",
  "💡",
  "🛠️",
  "🌟",
  "🍀",
  "🌻",
  "🍕",
  "💎",
] as const;

export type ProfileAvatar = (typeof PROFILE_AVATARS)[number];

const profileAvatarSet = new Set<string>(PROFILE_AVATARS);

export function isProfileAvatar(value: unknown): value is ProfileAvatar {
  return typeof value === "string" && profileAvatarSet.has(value);
}
