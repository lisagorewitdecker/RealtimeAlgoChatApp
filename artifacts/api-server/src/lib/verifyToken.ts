import { verifyToken as clerkVerifyToken } from "@clerk/backend";

/**
 * Verifies a Clerk session token (Bearer) and returns the userId.
 * Throws if the token is invalid or expired.
 */
export async function verifySessionToken(token: string): Promise<string> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set");

  const payload = await clerkVerifyToken(token, { secretKey });
  const userId = payload.sub;
  if (!userId) throw new Error("Token has no sub claim");
  return userId;
}
