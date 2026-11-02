import { Router } from "express";
import {
  getAccountProfile,
  getAccountSnapshot,
  normalizeProfileAvatar,
  normalizeProfileUsername,
  updateAccountProfile,
  type AccountProfile,
} from "../lib/accountProfile";
import { isConfiguredAdmin } from "../lib/accountAccess";
import { isProfileAvatar } from "../lib/profileAvatars";
import {
  getMainAdminEmail,
  isMainAdminEmail,
  mayUseDisplayName,
} from "../lib/profileIdentity";
import { requireAuthorizedUser } from "../lib/requireAccountAccess";
import {
  getPublicKeyRecord,
  registerPublicKey,
} from "../lib/e2eePersistence";
import { createIpRateLimit } from "../middlewares/rateLimit";

const router = Router();
const profileRateLimit = createIpRateLimit({
  scope: "profile-routes",
  windowMs: 60_000,
  maxRequests: 120,
});

router.use(profileRateLimit);

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

async function mayUseRequestedDisplayName(
  userId: string,
  username: string,
): Promise<boolean> {
  const account = { isConfiguredAdmin: isConfiguredAdmin(userId), isMainAdmin: false };
  if (mayUseDisplayName(username, account)) return true;
  if (!getMainAdminEmail()) return false;
  const { email } = await getAccountSnapshot(userId);
  return isMainAdminEmail(email);
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
    let current: AccountProfile | null = null;
    if (typeof avatarEmoji === "string" && !isProfileAvatar(avatarEmoji)) {
      // Avatars saved before the allowlist keep working: re-sending the
      // current value is accepted, but nothing new outside the list is.
      current = await getAccountProfile(userId);
      if (avatarEmoji !== current.avatarEmoji) {
        res.status(400).json({ error: "Invalid profile details." });
        return;
      }
    }
    if (
      typeof username === "string" &&
      !(await mayUseRequestedDisplayName(
        userId,
        normalizeProfileUsername(username),
      ))
    ) {
      res.status(400).json({
        error: "That display name is reserved. Choose a different name.",
        code: "RESERVED_USERNAME",
      });
      return;
    }
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
    current ??= await getAccountProfile(userId);
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