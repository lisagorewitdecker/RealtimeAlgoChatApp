import { getAuth } from "@clerk/express";
import type { Request, Response } from "express";
import { getAccountAccess } from "./accountAccess";
import {
  ACCOUNT_ACCESS_UNAVAILABLE_CODE,
  ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE,
  accountAccessRetryAfterSeconds,
} from "./accountAccessUnavailable";
import { logger } from "./logger";

export async function requireAuthorizedUser(
  req: Request,
  res: Response,
): Promise<string | null> {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required." });
    return null;
  }

  try {
    const access = await getAccountAccess(userId);
    if (access.allowed) return userId;
    res.status(403).json({
      error:
        access.reason === "banned"
          ? "Your RealtimeAlgoChatApp Studio account has been banned."
          : "Verify your email before entering RealtimeAlgoChatApp Studio.",
      code: access.reason === "banned" ? "BANNED" : "EMAIL_UNVERIFIED",
    });
  } catch (error) {
    // The lookup already spent its retry budget on Clerk; instead of holding
    // the request any longer, tell the client when to come back. The header
    // carries Clerk's (capped) guidance for the next attempt, and the body
    // repeats it for clients that only read JSON.
    const retryAfterSeconds = accountAccessRetryAfterSeconds(error);
    logger.warn({ err: error, retryAfterSeconds }, "Account access check failed");
    res
      .status(503)
      .setHeader("Retry-After", String(retryAfterSeconds))
      .json({
        error: ACCOUNT_ACCESS_UNAVAILABLE_MESSAGE,
        code: ACCOUNT_ACCESS_UNAVAILABLE_CODE,
        retryAfterSeconds,
      });
  }
  return null;
}
