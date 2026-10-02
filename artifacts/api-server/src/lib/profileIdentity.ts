/**
 * Server-side profile identity rules.
 * The main-admin email is intentionally not shipped in the mobile app bundle.
 */
export const MAIN_ADMIN_EMAIL = "lgorewit@icloud.com";
export const MAIN_ADMIN_NAME = "Lisa Gorewit-Decker";

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function canonicalProfileName(
  username: string,
  email: string | null,
): string {
  return email === MAIN_ADMIN_EMAIL ? MAIN_ADMIN_NAME : username;
}