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

/**
 * Checks a verified Clerk session token's `azp` (authorized party) claim
 * against the same deployment-managed origins.
 *
 * Clerk sets `azp` from the Origin header of the Frontend API request that
 * minted the token. Native Expo clients send no Origin, so their tokens carry
 * no `azp`; Clerk's own `authorizedParties` option rejects those tokens, which
 * is why this check is done here instead. A token minted by a browser on any
 * other origin is rejected. With no deployment domains configured (local
 * development and tests) every party is accepted, matching Clerk's behavior
 * for an empty `authorizedParties` list.
 */
export function isAuthorizedParty(azp: unknown): boolean {
  if (azp === undefined || azp === null || azp === "") return true;
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.length === 0) return true;
  return typeof azp === "string" && allowedOrigins.includes(azp);
}