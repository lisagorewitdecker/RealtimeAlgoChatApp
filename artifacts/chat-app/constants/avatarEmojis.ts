export const AVATAR_EMOJIS = [
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
] as const;

export type AvatarEmoji = (typeof AVATAR_EMOJIS)[number];

export const DEFAULT_AVATAR_EMOJI: AvatarEmoji = "🧑‍💻";