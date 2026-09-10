import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert, Platform } from "react-native";
import { encodeBase64 } from "tweetnacl-util";
import {
  DEVICE_KEY_RESET_IMPACT,
  DEVICE_KEY_RESET_TITLE,
  DeviceEncryptionCard,
  formatPublicKeyFingerprint,
} from "../components/DeviceEncryptionCard";
import type {
  DeviceIdentityResetResult,
  DeviceKeyRegistrationStatus,
} from "../contexts/CryptoContext";

const publicKeyBytes = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const publicKeyB64 = encodeBase64(publicKeyBytes);
const otherDeviceKeyB64 = encodeBase64(
  new Uint8Array(32).map((_, index) => (index * 53 + 5) % 256),
);
const mockResetDeviceIdentity = jest.fn<Promise<DeviceIdentityResetResult>, []>();
const mockCryptoState: {
  deviceKeyStatus: DeviceKeyRegistrationStatus;
  deviceKeyConflict: { registeredPublicKeyB64: string | null } | null;
  publicKeyB64: string;
} = { deviceKeyStatus: "registered", deviceKeyConflict: null, publicKeyB64 };

jest.mock("@/contexts/CryptoContext", () => ({
  useCrypto: () => ({
    deviceKeyStatus: mockCryptoState.deviceKeyStatus,
    deviceKeyConflict: mockCryptoState.deviceKeyConflict,
    publicKeyB64: mockCryptoState.publicKeyB64,
    resetDeviceIdentity: mockResetDeviceIdentity,
  }),
}));

jest.mock("@/contexts/AccessibilityContext", () => ({
  useFontScale: () => 1,
}));

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#10131a",
    card: "#171b24",
    border: "#343d4c",
    foreground: "#f4f6fa",
    mutedForeground: "#9aa5b5",
    primary: "#5aa5fa",
    destructive: "#d9534f",
    online: "#35b46d",
    radius: 12,
  }),
}));

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

type AlertButton = { text?: string; onPress?: () => void };

describe("DeviceEncryptionCard", () => {
  let alertSpy: jest.SpyInstance;
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    mockResetDeviceIdentity.mockReset();
    mockCryptoState.deviceKeyStatus = "registered";
    mockCryptoState.deviceKeyConflict = null;
    mockCryptoState.publicKeyB64 = publicKeyB64;
    alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
    Platform.OS = originalPlatform;
    delete (globalThis as { confirm?: unknown }).confirm;
  });

  it("shows the registration state and a public-key fingerprint without any secret material", () => {
    const { getByTestId, getByText } = render(<DeviceEncryptionCard />);

    expect(getByText("Registered with your account")).toBeTruthy();
    const fingerprint = getByTestId("device-key-fingerprint").props.children as string;
    expect(fingerprint).toBe(formatPublicKeyFingerprint(publicKeyB64));
    expect(fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(fingerprint).not.toBe(publicKeyB64);
    expect(getByTestId("reset-device-key-button").props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it("explains the impact before resetting and only resets after confirmation", async () => {
    mockResetDeviceIdentity.mockResolvedValue({
      status: "reset",
      publicKeyB64: "next-key",
    });
    const { getByTestId, queryByTestId } = render(<DeviceEncryptionCard />);

    fireEvent.press(getByTestId("reset-device-key-button"));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0] as [
      string,
      string,
      AlertButton[],
    ];
    expect(title).toBe(DEVICE_KEY_RESET_TITLE);
    expect(message).toBe(DEVICE_KEY_RESET_IMPACT);
    expect(message).toContain("Room keys already saved on this device keep working.");
    // Honest about what a reset cannot undo and about the account's other sessions.
    expect(message).toContain(
      "stay readable to anyone who still holds the old private key",
    );
    expect(message).toContain("Other devices and sessions stay signed in.");
    expect(message).toContain("their delayed re-registration cannot overwrite this key");
    expect(message).toContain("even one registered by another device or session");
    expect(message).toContain("Your account has exactly one registered key at a time");
    expect(message).toContain("resetting on another device later supersedes this one in turn");
    // Honest about which rooms a fresh device can and cannot recover.
    expect(message).toContain(
      "For rooms you created, only another signed-in device or session of yours that still holds the key can hand it over",
    );
    expect(message).toContain("without one, those rooms cannot be recovered");
    expect(message).toContain("Your private key never leaves this device and is never shown.");
    expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Reset key"]);

    act(() => {
      buttons[0]?.onPress?.();
    });
    expect(mockResetDeviceIdentity).not.toHaveBeenCalled();
    expect(queryByTestId("device-key-feedback")).toBeNull();

    await act(async () => {
      buttons[1]?.onPress?.();
    });
    expect(mockResetDeviceIdentity).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(getByTestId("device-key-feedback").props.children).toContain(
        "New device key created.",
      ),
    );
  });

  it("uses the browser confirmation result on web", async () => {
    Platform.OS = "web";
    mockResetDeviceIdentity.mockResolvedValue({
      status: "reset",
      publicKeyB64: "next-key",
    });
    const confirmMock = jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    (globalThis as { confirm?: unknown }).confirm = confirmMock;
    const { getByTestId } = render(<DeviceEncryptionCard />);

    fireEvent.press(getByTestId("reset-device-key-button"));
    expect(confirmMock).toHaveBeenCalledWith(
      `${DEVICE_KEY_RESET_TITLE}\n\n${DEVICE_KEY_RESET_IMPACT}`,
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockResetDeviceIdentity).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(getByTestId("reset-device-key-button"));
    });
    expect(mockResetDeviceIdentity).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["registering", "Registering with your account…"],
    ["retrying", "Registration failed; retrying automatically"],
    ["unavailable", "No device key yet"],
  ] as const)(
    "disables the reset while the device key is %s",
    (status, label) => {
      mockCryptoState.deviceKeyStatus = status;
      if (status === "unavailable") mockCryptoState.publicKeyB64 = "";
      const { getByTestId, getByText, queryByTestId } = render(<DeviceEncryptionCard />);

      expect(getByText(label)).toBeTruthy();
      expect(getByTestId("reset-device-key-button").props.accessibilityState).toMatchObject({
        disabled: true,
      });
      fireEvent.press(getByTestId("reset-device-key-button"));
      expect(alertSpy).not.toHaveBeenCalled();
      expect(mockResetDeviceIdentity).not.toHaveBeenCalled();
      if (status === "unavailable") {
        expect(queryByTestId("device-key-fingerprint")).toBeNull();
      }
    },
  );

  it("offers the reset as the recovery when another device or session superseded this key", async () => {
    Platform.OS = "web";
    const confirmMock = jest.fn().mockReturnValue(true);
    (globalThis as { confirm?: unknown }).confirm = confirmMock;
    mockCryptoState.deviceKeyStatus = "superseded";
    mockCryptoState.deviceKeyConflict = { registeredPublicKeyB64: otherDeviceKeyB64 };
    mockResetDeviceIdentity.mockResolvedValue({ status: "reset", publicKeyB64: "next-key" });
    const { getByTestId, getByText } = render(<DeviceEncryptionCard />);

    expect(getByText("Replaced by another device or session")).toBeTruthy();
    expect(getByText(/new room keys no longer reach this device/)).toBeTruthy();
    // Both fingerprints are public-key derived; neither reveals secret material.
    expect(getByTestId("device-key-fingerprint").props.children).toBe(
      formatPublicKeyFingerprint(publicKeyB64),
    );
    expect(getByTestId("device-key-conflicting-fingerprint").props.children).toBe(
      formatPublicKeyFingerprint(otherDeviceKeyB64),
    );
    expect(getByTestId("reset-device-key-button").props.accessibilityState).toMatchObject({
      disabled: false,
    });

    await act(async () => {
      fireEvent.press(getByTestId("reset-device-key-button"));
    });

    expect(confirmMock).toHaveBeenCalledWith(
      `${DEVICE_KEY_RESET_TITLE}\n\n${DEVICE_KEY_RESET_IMPACT}`,
    );
    expect(mockResetDeviceIdentity).toHaveBeenCalledTimes(1);
  });

  it("omits the conflicting fingerprint when the server did not name the other key", () => {
    mockCryptoState.deviceKeyStatus = "superseded";
    mockCryptoState.deviceKeyConflict = { registeredPublicKeyB64: null };
    const { queryByTestId, getByText } = render(<DeviceEncryptionCard />);

    expect(getByText("Replaced by another device or session")).toBeTruthy();
    expect(queryByTestId("device-key-conflicting-fingerprint")).toBeNull();
  });

  it.each([
    [
      { status: "storage_unavailable" } as const,
      "Secure storage on this device is unavailable, so nothing was changed.",
    ],
    [
      { status: "identity_changed" } as const,
      "The signed-in account changed during the reset.",
    ],
    [{ status: "not_ready" } as const, "Wait for the current key to finish registering"],
    [{ status: "unauthenticated" } as const, "Sign in to reset this device's encryption key."],
  ])("reports the recovery failure %p without changing the identity", async (result, message) => {
    Platform.OS = "web";
    (globalThis as { confirm?: unknown }).confirm = jest.fn().mockReturnValue(true);
    mockResetDeviceIdentity.mockResolvedValue(result);
    const { getByTestId } = render(<DeviceEncryptionCard />);

    await act(async () => {
      fireEvent.press(getByTestId("reset-device-key-button"));
    });

    expect(getByTestId("device-key-feedback").props.children).toContain(message);
    expect(getByTestId("device-key-fingerprint").props.children).toBe(
      formatPublicKeyFingerprint(publicKeyB64),
    );
  });

  it("reports an unexpected failure instead of leaving the button stuck", async () => {
    Platform.OS = "web";
    (globalThis as { confirm?: unknown }).confirm = jest.fn().mockReturnValue(true);
    mockResetDeviceIdentity.mockRejectedValue(new Error("boom"));
    const { getByTestId } = render(<DeviceEncryptionCard />);

    await act(async () => {
      fireEvent.press(getByTestId("reset-device-key-button"));
    });

    expect(getByTestId("device-key-feedback").props.children).toContain(
      "The device key could not be reset.",
    );
    expect(getByTestId("reset-device-key-button").props.accessibilityState).toMatchObject({
      disabled: false,
      busy: false,
    });
  });
});
