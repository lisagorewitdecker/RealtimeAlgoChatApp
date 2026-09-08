import { getAuth } from "@clerk/express";
import type { Request, Response } from "express";
import { getAccountAccess } from "./accountAccess";
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
    logger.warn({ err: error }, "Account access check failed");
    res.status(503).json({ error: "Account access is temporarily unavailable." });
  }
  return null;
}