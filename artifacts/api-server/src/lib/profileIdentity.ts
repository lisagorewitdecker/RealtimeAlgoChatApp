/**
 * Server-side profile identity rules.
 * The main-admin email comes from the MAIN_ADMIN_EMAIL environment variable so
 * it is never shipped in the mobile app bundle or committed to the repository.
 *
 * This module has no imports so `node --test` can load it directly.
 */
export const MAIN_ADMIN_NAME = "Lisa Gorewit-Decker";

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * The normalized main-admin email, or null when MAIN_ADMIN_EMAIL is unset or
 * malformed. Failing closed means no account gets main-admin treatment.
 */
export function getMainAdminEmail(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = normalizeEmail(env["MAIN_ADMIN_EMAIL"] ?? "");
  return configured && isValidEmail(configured) ? configured : null;
}

export function isMainAdminEmail(email: string | null | undefined): boolean {
  const mainAdminEmail = getMainAdminEmail();
  return (
    mainAdminEmail !== null &&
    typeof email === "string" &&
    normalizeEmail(email) === mainAdminEmail
  );
}

export function canonicalProfileName(
  username: string,
  email: string | null,
): string {
  return isMainAdminEmail(email) ? MAIN_ADMIN_NAME : username;
}

/**
 * Names that only administrators may use: "System" labels server-generated
 * room messages, and the others claim staff authority.
 */
export const RESERVED_DISPLAY_NAMES = [
  "System",
  "Admin",
  "Administrator",
  "Moderator",
  MAIN_ADMIN_NAME,
] as const;

// Look-alike characters folded onto one Latin letter. The fold is only used to
// compare against the reserved names above, never to rewrite a stored name.
const CONFUSABLE_FOLDS: Record<string, string> = {
  "0": "o",
  "1": "l",
  i: "l",
  ı: "l",
  // Cyrillic
  а: "a",
  в: "b",
  е: "e",
  һ: "h",
  н: "h",
  і: "l",
  ӏ: "l",
  ј: "j",
  к: "k",
  м: "m",
  о: "o",
  р: "p",
  с: "c",
  ѕ: "s",
  т: "t",
  у: "y",
  х: "x",
  ԁ: "d",
  // Greek
  α: "a",
  β: "b",
  ε: "e",
  ζ: "z",
  η: "h",
  ι: "l",
  κ: "k",
  μ: "m",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "y",
  χ: "x",
};

/**
 * Comparison key for a display name: compatibility-normalized, case-folded,
 * without invisible format characters, accents, spacing, or punctuation, and
 * with common look-alike characters folded together.
 */
export function displayNameSkeleton(value: string): string {
  return Array.from(
    value
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]/gu, ""),
    (character) => CONFUSABLE_FOLDS[character] ?? character,
  ).join("");
}

const RESERVED_DISPLAY_NAME_SKELETONS = new Set<string>(
  RESERVED_DISPLAY_NAMES.map(displayNameSkeleton),
);

export function isReservedDisplayName(value: string): boolean {
  return RESERVED_DISPLAY_NAME_SKELETONS.has(displayNameSkeleton(value));
}
