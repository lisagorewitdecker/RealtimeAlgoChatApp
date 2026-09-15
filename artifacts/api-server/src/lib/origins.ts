function toOrigin(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith("http") ? item : `https://${item}`));
}

export function getAllowedOrigins(): string[] {
  return Array.from(
    new Set([
      ...toOrigin(process.env["REPLIT_DEV_DOMAIN"]),
      ...toOrigin(process.env["REPLIT_EXPO_DEV_DOMAIN"]),
      ...toOrigin(process.env["REPLIT_DOMAINS"]),
      ...toOrigin(process.env["REPLIT_INTERNAL_APP_DOMAIN"]),
    ]),
  );
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  // Native Expo requests do not send an Origin header. Browser requests must
  // originate from one of the deployment-managed domains above.
  return !origin || getAllowedOrigins().includes(origin);
}