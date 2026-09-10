import { Router } from "express";
import {
  getAccountProfile,
  normalizeProfileAvatar,
  normalizeProfileUsername,
  updateAccountProfile,
} from "../lib/accountProfile";
import { isConfiguredAdmin } from "../lib/accountAccess";
import { requireAuthorizedUser } from "../lib/requireAccountAccess";
import { getPublicKey, registerPublicKey } from "../lib/e2eePersistence";

const router = Router();

function isValidPublicKey(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

router.get("/", async (req, res, next) => {
  const userId = await requireAuthorizedUser(req, res);
  if (!userId) return;
  try {
    const [profile, publicKey] = await Promise.all([
      getAccountProfile(userId),
      getPublicKey(userId),
    ]);
    res.json({
      profile,
      publicKey,
      isAdmin: isConfiguredAdmin(userId),
    });
  } catch (error) {
    next(error);
  }
});

router.put("/", async (req, res, next) => {
  const userId = await requireAuthorizedUser(req, res);
  if (!userId) return;
  const body =
    req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  const username = body?.["username"];
  const avatarEmoji = body?.["avatarEmoji"];
  const publicKey = body?.["publicKey"];
  // Which key this write replaces (`null`: none registered yet). Omitting it
  // only ever registers a first key or re-sends the current one; replacing a
  // different key requires naming it so stale devices cannot overwrite a reset.
  const previousPublicKey = body?.["previousPublicKey"];
  if (
    (previousPublicKey !== undefined &&
      previousPublicKey !== null &&
      !isValidPublicKey(previousPublicKey)) ||
    (previousPublicKey !== undefined && publicKey === undefined) ||
    (username !== undefined &&
      (typeof username !== "string" ||
        username.trim().replace(/\s+/g, " ").length < 2 ||
        username.trim().replace(/\s+/g, " ").length > 30)) ||
    (avatarEmoji !== undefined &&
      (typeof avatarEmoji !== "string" ||
        !avatarEmoji.trim() ||
        avatarEmoji.length > 16)) ||
    (publicKey !== undefined && !isValidPublicKey(publicKey))
  ) {
    res.status(400).json({ error: "Invalid profile details." });
    return;
  }

  try {
    if (typeof publicKey === "string") {
      const registration = await registerPublicKey(
        userId,
        publicKey,
        typeof previousPublicKey === "string" ? previousPublicKey : null,
      );
      if (registration.outcome === "conflict") {
        res.status(409).json({
          error:
            "A different encryption key is registered for this account. Reset the device key to replace it.",
          code: "PUBLIC_KEY_CONFLICT",
          publicKey: registration.registeredPublicKey,
        });
        return;
      }
      if (username === undefined && avatarEmoji === undefined) {
        res.json({ publicKey });
        return;
      }
    }
    const current = await getAccountProfile(userId);
    const profile = await updateAccountProfile(userId, {
      username:
        username === undefined
          ? current.username
          : normalizeProfileUsername(username),
      avatarEmoji:
        avatarEmoji === undefined
          ? current.avatarEmoji
          : normalizeProfileAvatar(avatarEmoji),
    });
    res.json({
      profile,
      ...(typeof publicKey === "string" ? { publicKey } : {}),
    });
  } catch (error) {
    next(error);
  }
});

export default router;