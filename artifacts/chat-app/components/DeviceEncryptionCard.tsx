import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import { Alert, Platform, StyleSheet, TouchableOpacity, View } from "react-native";
import { decodeBase64 } from "tweetnacl-util";
import { ScaledText as Text } from "@/components/ScaledText";
import {
  type DeviceIdentityResetResult,
  type DeviceKeyRegistrationStatus,
  useCrypto,
} from "@/contexts/CryptoContext";
import { useColors } from "@/hooks/useColors";
import { trackEvent } from "@/utils/analytics";

export const DEVICE_KEY_RESET_TITLE = "Reset device encryption key?";

/**
 * Impact statement shown before a reset is confirmed. It describes exactly
 * what changes, what keeps working, what the reset cannot undo, and how other
 * devices and sessions on the account are affected.
 */
export const DEVICE_KEY_RESET_IMPACT = [
  "This device gets a new encryption key and registers it with your account. Your account has exactly one registered key at a time: this replaces the key registered now, even one registered by another device or session, and resetting on another device later supersedes this one in turn.",
  "Encrypted rooms stay unavailable on this device until the server confirms the new key.",
  "Room keys already saved on this device keep working. Rooms without a saved key need their creator online again to send a fresh one. For rooms you created, only another signed-in device or session of yours that still holds the key can hand it over, while it has that room open; without one, those rooms cannot be recovered.",
  "Room keys that were already sent to the old key stay readable to anyone who still holds the old private key. Only room keys sent from now on are protected by the new key.",
  "Other devices and sessions stay signed in. Any still using the old key stop receiving new room keys until you reset there too; their delayed re-registration cannot overwrite this key.",
  "Your private key never leaves this device and is never shown.",
].join("\n\n");

const STATUS_COPY: Record<
  DeviceKeyRegistrationStatus,
  { label: string; detail: string }
> = {
  unavailable: {
    label: "No device key yet",
    detail: "This device creates its encryption key as soon as you are signed in.",
  },
  registering: {
    label: "Registering with your account…",
    detail: "Encrypted rooms open once the server confirms this key.",
  },
  retrying: {
    label: "Registration failed; retrying automatically",
    detail:
      "The server has not confirmed this key yet. Encrypted rooms stay unavailable until it does.",
  },
  registered: {
    label: "Registered with your account",
    detail: "Other members use this key to send you room keys.",
  },
  superseded: {
    label: "Replaced by another device or session",
    detail:
      "Your account is registered under a different key, so new room keys no longer reach this device. Rooms you created and still hold the key for are handed to that key while you have them open here. Reset the key here to make this device the registered one instead.",
  },
};

export function describeDeviceIdentityReset(
  result: DeviceIdentityResetResult,
): { kind: "success" | "error"; message: string } {
  switch (result.status) {
    case "reset":
      return {
        kind: "success",
        message:
          "New device key created. It is being registered now; encrypted rooms reopen once the server confirms it.",
      };
    case "unauthenticated":
      return {
        kind: "error",
        message: "Sign in to reset this device's encryption key.",
      };
    case "not_ready":
      return {
        kind: "error",
        message: "Wait for the current key to finish registering, then try again.",
      };
    case "storage_unavailable":
      return {
        kind: "error",
        message:
          "Secure storage on this device is unavailable, so nothing was changed. Make it available and try again.",
      };
    case "identity_changed":
      return {
        kind: "error",
        message:
          "The signed-in account changed during the reset. Sign in again and retry.",
      };
  }
}

/**
 * Short, human-comparable identifier derived from the public key only. It is
 * safe to display: the same value is already shared with room members.
 */
export function formatPublicKeyFingerprint(publicKeyB64: string): string {
  if (!publicKeyB64) return "";
  try {
    const bytes = decodeBase64(publicKeyB64).slice(0, 8);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
  } catch {
    return "";
  }
}

export function DeviceEncryptionCard() {
  const colors = useColors();
  const {
    deviceKeyStatus,
    isDeviceKeyRegistrationSlow,
    deviceKeyConflict,
    publicKeyB64,
    resetDeviceIdentity,
  } = useCrypto();
  const [isResetting, setIsResetting] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const status =
    isDeviceKeyRegistrationSlow &&
    (deviceKeyStatus === "registering" || deviceKeyStatus === "retrying")
    ? {
        label: "Still registering your device key",
        detail:
          "Check your connection; encrypted rooms stay closed until it completes.",
      }
    : STATUS_COPY[deviceKeyStatus];
  const fingerprint = formatPublicKeyFingerprint(publicKeyB64);
  const conflictingFingerprint = deviceKeyConflict?.registeredPublicKeyB64
    ? formatPublicKeyFingerprint(deviceKeyConflict.registeredPublicKeyB64)
    : "";
  // A superseded key is idle on the server side, so taking over from it is
  // the intended recovery; keys still registering must finish first.
  const canReset =
    (deviceKeyStatus === "registered" || deviceKeyStatus === "superseded") && !isResetting;

  async function performReset() {
    setIsResetting(true);
    setFeedback(null);
    try {
      const result = await resetDeviceIdentity();
      const description = describeDeviceIdentityReset(result);
      setFeedback(description);
      trackEvent("device_key_reset", { result: result.status });
      if (description.kind === "success") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch {
      setFeedback({
        kind: "error",
        message: "The device key could not be reset. Nothing was changed; try again.",
      });
    } finally {
      setIsResetting(false);
    }
  }

  function confirmReset() {
    if (!canReset) return;
    if (Platform.OS === "web") {
      // React Native Web does not reliably run Alert button callbacks; the
      // browser confirmation result is the source of truth there.
      if (globalThis.confirm(`${DEVICE_KEY_RESET_TITLE}\n\n${DEVICE_KEY_RESET_IMPACT}`)) {
        void performReset();
      }
      return;
    }
    Alert.alert(DEVICE_KEY_RESET_TITLE, DEVICE_KEY_RESET_IMPACT, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset key",
        style: "destructive",
        onPress: () => void performReset(),
      },
    ]);
  }

  return (
    <View
      testID="device-encryption-card"
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
      ]}
    >
      <View style={styles.heading}>
        <Feather name="shield" size={16} color={colors.primary} />
        <Text style={[styles.sectionLabel, { color: colors.primary }]}>
          DEVICE ENCRYPTION
        </Text>
      </View>
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        Each device has its own end-to-end encryption key for this account. The
        private half stays on this device only.
      </Text>

      <View style={styles.statusRow}>
        <View
          style={[
            styles.statusDot,
            {
              backgroundColor:
                deviceKeyStatus === "registered"
                  ? colors.online
                  : deviceKeyStatus === "retrying" || deviceKeyStatus === "superseded"
                    ? colors.destructive
                    : colors.mutedForeground,
            },
          ]}
        />
        <View style={styles.statusCopy}>
          <Text
            testID="device-key-status"
            accessibilityLiveRegion="polite"
            style={[styles.statusLabel, { color: colors.foreground }]}
          >
            {status.label}
          </Text>
          <Text style={[styles.statusDetail, { color: colors.mutedForeground }]}>
            {status.detail}
          </Text>
        </View>
      </View>

      {fingerprint ? (
        <View style={styles.fingerprintRow}>
          <Text style={[styles.fingerprintLabel, { color: colors.mutedForeground }]}>
            Public key fingerprint
          </Text>
          <Text
            testID="device-key-fingerprint"
            style={[styles.fingerprint, { color: colors.foreground }]}
            selectable
          >
            {fingerprint}
          </Text>
        </View>
      ) : null}

      {conflictingFingerprint ? (
        <View style={styles.fingerprintRow}>
          <Text style={[styles.fingerprintLabel, { color: colors.mutedForeground }]}>
            Key registered for your account instead
          </Text>
          <Text
            testID="device-key-conflicting-fingerprint"
            style={[styles.fingerprint, { color: colors.foreground }]}
            selectable
          >
            {conflictingFingerprint}
          </Text>
        </View>
      ) : null}

      <TouchableOpacity
        testID="reset-device-key-button"
        accessibilityRole="button"
        accessibilityLabel="Reset device encryption key"
        accessibilityHint="Replaces this device's encryption key after confirmation"
        accessibilityState={{ disabled: !canReset, busy: isResetting }}
        disabled={!canReset}
        onPress={confirmReset}
        style={[
          styles.resetButton,
          {
            borderColor: colors.destructive,
            backgroundColor: `${colors.destructive}14`,
            borderRadius: colors.radius - 2,
            opacity: canReset ? 1 : 0.5,
          },
        ]}
      >
        <Feather name="refresh-cw" size={15} color={colors.destructive} />
        <Text style={[styles.resetButtonText, { color: colors.destructive }]}>
          {isResetting ? "Resetting…" : "Reset device encryption key"}
        </Text>
      </TouchableOpacity>
      <Text style={[styles.resetHint, { color: colors.mutedForeground }]}>
        Use this after restoring the app on a new device or if you think this
        device's key was exposed. You will confirm the impact first.
      </Text>

      {feedback ? (
        <Text
          testID="device-key-feedback"
          accessibilityLiveRegion="polite"
          style={[
            styles.feedback,
            { color: feedback.kind === "success" ? colors.online : colors.destructive },
          ]}
        >
          {feedback.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, borderWidth: 1, gap: 10 },
  heading: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionLabel: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.8 },
  hint: { fontSize: 12, lineHeight: 18 },
  statusRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingTop: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  statusCopy: { flex: 1, gap: 2 },
  statusLabel: { fontSize: 14, fontWeight: "600" as const },
  statusDetail: { fontSize: 12, lineHeight: 17 },
  fingerprintRow: { gap: 2 },
  fingerprintLabel: { fontSize: 11, fontWeight: "600" as const },
  fingerprint: {
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
    letterSpacing: 0.5,
  },
  resetButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 44,
    borderWidth: 1,
    paddingHorizontal: 14,
    marginTop: 4,
  },
  resetButtonText: { fontSize: 14, fontWeight: "700" as const },
  resetHint: { fontSize: 12, lineHeight: 17 },
  feedback: { fontSize: 13, fontWeight: "600" as const, lineHeight: 19 },
});
