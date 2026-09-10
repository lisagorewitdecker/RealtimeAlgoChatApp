import AsyncStorage from "@react-native-async-storage/async-storage";
import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import {
  AccessibilityProvider,
  useAccessibility,
} from "../contexts/AccessibilityContext";

const STORAGE_KEY = "devstudio_accessibility_prefs";

type PreferenceSnapshot = {
  highContrast: boolean;
  fontScale: number;
  reduceMotion: boolean;
};

type PreferenceActions = {
  setHighContrast: (value: boolean) => void;
  setFontScale: (value: 1.0 | 1.1 | 1.2 | 1.4) => void;
  setReduceMotion: (value: boolean) => void;
  retryPersistence: () => Promise<boolean>;
};

let currentPreferences: PreferenceSnapshot | null = null;
let preferenceActions: PreferenceActions | null = null;
let currentPersistenceError: string | null = null;
let reduceMotionListener: ((enabled: boolean) => void) | null = null;
let removeReduceMotionListener: jest.Mock | null = null;

function AccessibilityProbe() {
  const {
    highContrast,
    fontScale,
    reduceMotion,
    setHighContrast,
    setFontScale,
    setReduceMotion,
    retryPersistence,
    persistenceError,
  } = useAccessibility();
  currentPreferences = { highContrast, fontScale, reduceMotion };
  preferenceActions = {
    setHighContrast,
    setFontScale,
    setReduceMotion,
    retryPersistence,
  };
  currentPersistenceError = persistenceError;
  return null;
}

const getItemMock = AsyncStorage.getItem as jest.Mock;
const setItemMock = AsyncStorage.setItem as jest.Mock;
const isReduceMotionEnabledMock = AccessibilityInfo.isReduceMotionEnabled as jest.Mock;
const addEventListenerMock = AccessibilityInfo.addEventListener as jest.Mock;

async function renderAccessibilityProvider() {
  const view = render(
    <AccessibilityProvider>
      <AccessibilityProbe />
    </AccessibilityProvider>,
  );

  // Provider initialization happens in an effect after render.
  await act(async () => {});

  return view;
}

describe("AccessibilityProvider", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    currentPreferences = null;
    preferenceActions = null;
    currentPersistenceError = null;
    reduceMotionListener = null;
    removeReduceMotionListener = jest.fn();

    getItemMock.mockResolvedValue(null);
    isReduceMotionEnabledMock.mockResolvedValue(false);
    addEventListenerMock.mockImplementation(
      (
        _event: string,
        listener: (enabled: boolean) => void,
      ) => {
        reduceMotionListener = listener;
        return { remove: removeReduceMotionListener };
      },
    );
  });

  it("loads persisted high-contrast, font-scale, and reduce-motion preferences", async () => {
    getItemMock.mockResolvedValueOnce(
      JSON.stringify({
        highContrast: true,
        fontScale: 1.4,
        reduceMotion: true,
      }),
    );

    const view = await renderAccessibilityProvider();

    await waitFor(() =>
      expect(currentPreferences).toEqual({
        highContrast: true,
        fontScale: 1.4,
        reduceMotion: true,
      }),
    );
    expect(getItemMock).toHaveBeenCalledWith(STORAGE_KEY);
    view.unmount();
  });

  it("falls back to defaults when persisted data is malformed", async () => {
    getItemMock.mockResolvedValueOnce("{not valid JSON");

    const view = await renderAccessibilityProvider();

    await waitFor(() =>
      expect(currentPreferences).toEqual({
        highContrast: false,
        fontScale: 1,
        reduceMotion: false,
      }),
    );
    view.unmount();
  });

  it("falls back to defaults when storage cannot be read", async () => {
    getItemMock.mockRejectedValueOnce(new Error("storage unavailable"));

    const view = await renderAccessibilityProvider();

    await waitFor(() =>
      expect(currentPreferences).toEqual({
        highContrast: false,
        fontScale: 1,
        reduceMotion: false,
      }),
    );
    view.unmount();
  });

  it("keeps the changed preference usable and offers an accessible retry when storage cannot be written", async () => {
    const view = await renderAccessibilityProvider();
    setItemMock.mockRejectedValueOnce(new Error("storage unavailable"));

    await act(async () => {
      preferenceActions?.setHighContrast(true);
    });

    await waitFor(() => {
      expect(currentPreferences?.highContrast).toBe(true);
      expect(currentPersistenceError).toBe(
        "Your accessibility preference changed, but could not be saved. Retry saving preferences.",
      );
    });
    expect(
      view.getByText(
        "Your accessibility preference changed, but could not be saved. Retry saving preferences.",
      ),
    ).toBeTruthy();
    const retryButton = view.getByRole("button", {
      name: "Retry saving accessibility preferences",
    });

    setItemMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.press(retryButton);
    });

    await waitFor(() => expect(currentPersistenceError).toBeNull());
    expect(currentPreferences?.highContrast).toBe(true);
    expect(setItemMock).toHaveBeenLastCalledWith(
      STORAGE_KEY,
      JSON.stringify({ highContrast: true, fontScale: 1, reduceMotion: false }),
    );
    view.unmount();
  });

  it("retries the complete preference object after a write failure", async () => {
    getItemMock.mockResolvedValueOnce(
      JSON.stringify({
        highContrast: true,
        fontScale: 1.4,
        reduceMotion: true,
      }),
    );
    const view = await renderAccessibilityProvider();
    await waitFor(() =>
      expect(currentPreferences).toEqual({
        highContrast: true,
        fontScale: 1.4,
        reduceMotion: true,
      }),
    );

    setItemMock.mockRejectedValueOnce(new Error("storage unavailable"));
    await act(async () => {
      preferenceActions?.setFontScale(1.2);
    });
    await waitFor(() => expect(currentPersistenceError).not.toBeNull());

    setItemMock.mockResolvedValueOnce(undefined);
    await act(async () => {
      await preferenceActions?.retryPersistence();
    });

    expect(setItemMock).toHaveBeenLastCalledWith(
      STORAGE_KEY,
      JSON.stringify({ highContrast: true, fontScale: 1.2, reduceMotion: true }),
    );
    view.unmount();
  });

  it("applies the system reduce-motion setting during initial load", async () => {
    isReduceMotionEnabledMock.mockResolvedValueOnce(true);

    const view = await renderAccessibilityProvider();

    await waitFor(() => expect(currentPreferences?.reduceMotion).toBe(true));
    view.unmount();
  });

  it("keeps a saved reduce-motion choice of false after restart when the system setting is enabled", async () => {
    getItemMock.mockResolvedValueOnce(
      JSON.stringify({
        highContrast: false,
        fontScale: 1,
        reduceMotion: false,
      }),
    );
    isReduceMotionEnabledMock.mockResolvedValueOnce(true);

    const view = await renderAccessibilityProvider();

    await waitFor(() => expect(currentPreferences?.reduceMotion).toBe(false));

    await act(async () => {
      reduceMotionListener?.(true);
    });
    expect(currentPreferences?.reduceMotion).toBe(false);

    await act(async () => {
      reduceMotionListener?.(false);
    });
    expect(currentPreferences?.reduceMotion).toBe(false);

    view.unmount();
  });

  it("responds to system reduce-motion changes", async () => {
    const view = await renderAccessibilityProvider();

    expect(reduceMotionListener).not.toBeNull();
    await act(async () => {
      reduceMotionListener?.(true);
    });
    expect(currentPreferences?.reduceMotion).toBe(true);

    await act(async () => {
      reduceMotionListener?.(false);
    });
    expect(currentPreferences?.reduceMotion).toBe(false);

    view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "keeps the manual reduce-motion choice (%s) when the system setting changes",
    async (manualChoice) => {
      const view = await renderAccessibilityProvider();

      await act(async () => {
        preferenceActions?.setReduceMotion(manualChoice);
      });
      await act(async () => {
        reduceMotionListener?.(!manualChoice);
      });

      expect(currentPreferences?.reduceMotion).toBe(manualChoice);
      view.unmount();
    },
  );

  it.each([
    [
      "high contrast",
      (actions: PreferenceActions) => actions.setHighContrast(true),
      { highContrast: true, fontScale: 1, reduceMotion: false },
    ],
    [
      "font scale",
      (actions: PreferenceActions) => actions.setFontScale(1.4),
      { highContrast: false, fontScale: 1.4, reduceMotion: false },
    ],
    [
      "reduce motion",
      (actions: PreferenceActions) => actions.setReduceMotion(true),
      { highContrast: false, fontScale: 1, reduceMotion: true },
    ],
  ])("persists a complete preference object when changing %s", async (_name, update, expected) => {
    const view = await renderAccessibilityProvider();

    await act(async () => {
      update(preferenceActions!);
    });

    expect(setItemMock).toHaveBeenCalledTimes(1);
    expect(setItemMock).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(expected));
    view.unmount();
  });

  it.each([
    [
      "high contrast",
      (actions: PreferenceActions) => actions.setHighContrast(true),
      { highContrast: true, fontScale: 1, reduceMotion: false },
    ],
    [
      "font scale",
      (actions: PreferenceActions) => actions.setFontScale(1.4),
      { highContrast: false, fontScale: 1.4, reduceMotion: false },
    ],
    [
      "reduce motion",
      (actions: PreferenceActions) => actions.setReduceMotion(true),
      { highContrast: false, fontScale: 1, reduceMotion: true },
    ],
  ])("restores changed %s preferences after a provider restart", async (_name, update, expected) => {
    const firstView = await renderAccessibilityProvider();

    await act(async () => {
      update(preferenceActions!);
    });

    await waitFor(() =>
      expect(setItemMock).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(expected)),
    );
    const serializedPreferences = setItemMock.mock.calls[setItemMock.mock.calls.length - 1]?.[1];
    expect(serializedPreferences).toBe(JSON.stringify(expected));

    firstView.unmount();
    getItemMock.mockResolvedValueOnce(serializedPreferences);

    const secondView = await renderAccessibilityProvider();
    await waitFor(() => expect(currentPreferences).toEqual(expected));
    secondView.unmount();
  });

  it.each([
    [
      "high contrast",
      (actions: PreferenceActions) => actions.setHighContrast(false),
      { highContrast: false, fontScale: 1.4, reduceMotion: true },
    ],
    [
      "font scale",
      (actions: PreferenceActions) => actions.setFontScale(1.0),
      { highContrast: true, fontScale: 1, reduceMotion: true },
    ],
    [
      "reduce motion",
      (actions: PreferenceActions) => actions.setReduceMotion(false),
      { highContrast: true, fontScale: 1.4, reduceMotion: false },
    ],
  ])("preserves saved preferences when changing only %s", async (_name, update, expected) => {
    getItemMock.mockResolvedValueOnce(
      JSON.stringify({
        highContrast: true,
        fontScale: 1.4,
        reduceMotion: true,
      }),
    );

    const view = await renderAccessibilityProvider();

    await waitFor(() =>
      expect(currentPreferences).toEqual({
        highContrast: true,
        fontScale: 1.4,
        reduceMotion: true,
      }),
    );

    await act(async () => {
      update(preferenceActions!);
    });

    expect(setItemMock).toHaveBeenCalledTimes(1);
    expect(setItemMock).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(expected));
    view.unmount();
  });
});
