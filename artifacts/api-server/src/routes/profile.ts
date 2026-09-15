import { Router } from "express";
import {
  getAccountProfile,
  normalizeProfileAvatar,
  normalizeProfileUsername,
  updateAccountProfile,
} from "../lib/accountProfile";
import { isConfiguredAdmin } from "../lib/accountAccess";
import { requireAuthorizedUser } from "../lib/requireAccountAccess";
import {
  getPublicKeyRecord,
  registerPublicKey,
} from "../lib/e2eePersistence";

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
  // This response contains account-specific data, including the server-owned
  // admin flag and the device public key. It must never be reused as a cached
  // response for a later profile load.
  res.set("Cache-Control", "no-store");
  try {
    const [profile, publicKeyRecord] = await Promise.all([
      getAccountProfile(userId),
      getPublicKeyRecord(userId),
    ]);
    res.json({
      profile,
      publicKey: publicKeyRecord.publicKey,
      ...(publicKeyRecord.registrationVersion === null
        ? {}
        : { registrationVersion: publicKeyRecord.registrationVersion }),
      isAdmin: isConfiguredAdmin(userId),
    });
  } catch (error) {
    next(error);
  }
});

router.put("/", async (req, res, next) => {
  const userId = await requireAuthorizedUser(req, res);
  if (!userId) return;
  res.set("Cache-Control", "no-store");
  const body =
    req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : null;
  const username = body?.["username"];
  const avatarEmoji = body?.["avatarEmoji"];
  const publicKey = body?.["publicKey"];
  const registrationVersion = body?.["registrationVersion"];
  // Which key this write replaces (`null`: none registered yet). Omitting it
  // only ever registers a first key or re-sends the current one; replacing a
  // different key requires naming it so stale devices cannot overwrite a reset.
  const previousPublicKey = body?.["previousPublicKey"];
  if (
    (previousPublicKey !== undefined &&
      previousPublicKey !== null &&
      !isValidPublicKey(previousPublicKey)) ||
    (previousPublicKey !== undefined && publicKey === undefined) ||
    (registrationVersion !== undefined &&
      registrationVersion !== null &&
      (typeof registrationVersion !== "number" ||
        !Number.isSafeInteger(registrationVersion) ||
        registrationVersion < 0)) ||
    (registrationVersion !== undefined && publicKey === undefined) ||
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
      const registration =
        typeof registrationVersion === "number"
          ? await registerPublicKey(
              userId,
              publicKey,
              typeof previousPublicKey === "string" ? previousPublicKey : null,
              registrationVersion,
            )
          : await registerPublicKey(
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
      if (registration.outcome === "stale") {
        res.status(409).json({
          error:
            "This encryption key registration is older than the key already registered for this account.",
          code: "PUBLIC_KEY_STALE",
          publicKey: registration.registeredPublicKey,
          registrationVersion: registration.registrationVersion,
        });
        return;
      }
      if (registration.outcome === "future") {
        res.status(409).json({
          error:
            "This encryption key registration is ahead of the account revision.",
          code: "PUBLIC_KEY_VERSION_AHEAD",
          publicKey: registration.registeredPublicKey,
          registrationVersion: registration.registrationVersion,
        });
        return;
      }
      if (username === undefined && avatarEmoji === undefined) {
        res.json({
          publicKey,
          ...(typeof registrationVersion === "number"
            ? { registrationVersion }
            : {}),
        });
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
      ...(typeof registrationVersion === "number" ? { registrationVersion } : {}),
    });
  } catch (error) {
    next(error);
  }
});

export default router;