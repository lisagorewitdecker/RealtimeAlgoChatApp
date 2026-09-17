/**
 * AccessibilityContext — stores user accessibility preferences:
 *   - highContrast: stronger color contrast for low-vision users
 *   - fontScale: multiplier for text sizes (1.0 – 1.4)
 *   - reduceMotion: disable animations / transitions
 *   - reduceTransparency: opaque controls (the classic tab bar) instead of
 *     see-through ones
 *
 * Preferences are persisted to AsyncStorage. reduceMotion and
 * reduceTransparency also follow the system settings of the same name until
 * the user sets the in-app toggle, which then overrides the system value and
 * keeps overriding it across restarts. iOS is the only platform with a system
 * Reduce Transparency setting: React Native resolves the query to `false` on
 * Android and react-native-web does not implement it, so there the toggle
 * simply starts off.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from "react-native";

const STORAGE_KEY = "devstudio_accessibility_prefs";

type FontScale = 1.0 | 1.1 | 1.2 | 1.4;

interface AccessibilityPrefs {
  highContrast: boolean;
  fontScale: FontScale;
  reduceMotion: boolean;
  reduceTransparency: boolean;
}

interface AccessibilityContextValue extends AccessibilityPrefs {
  setHighContrast: (v: boolean) => void;
  setFontScale: (v: FontScale) => void;
  setReduceMotion: (v: boolean) => void;
  setReduceTransparency: (v: boolean) => void;
  persistenceError: string | null;
  retryPersistence: () => Promise<boolean>;
}

const defaults: AccessibilityPrefs = {
  highContrast: false,
  fontScale: 1.0,
  reduceMotion: false,
  reduceTransparency: false,
};

/**
 * The system Reduce Transparency value, or `null` where the platform has no
 * such setting to read (react-native-web's AccessibilityInfo has no
 * `isReduceTransparencyEnabled` at all).
 */
async function readSystemReduceTransparency(): Promise<boolean | null> {
  if (typeof AccessibilityInfo.isReduceTransparencyEnabled !== "function") {
    return null;
  }
  return AccessibilityInfo.isReduceTransparencyEnabled();
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(null);

export function AccessibilityProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<AccessibilityPrefs>(defaults);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const manualReduceMotion = useRef<boolean | null>(null);
  const manualReduceTransparency = useRef<boolean | null>(null);
  const pendingPersistence = useRef<AccessibilityPrefs | null>(null);
  const persistenceRequestId = useRef(0);
  const mounted = useRef(true);

  // Load persisted prefs and detect the system reduce-motion and
  // reduce-transparency settings on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded: AccessibilityPrefs = { ...defaults };

      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<AccessibilityPrefs>;
          loaded = {
            highContrast: parsed.highContrast ?? defaults.highContrast,
            fontScale: (parsed.fontScale as FontScale) ?? defaults.fontScale,
            reduceMotion: parsed.reduceMotion ?? defaults.reduceMotion,
            reduceTransparency: parsed.reduceTransparency ?? defaults.reduceTransparency,
          };
          if (typeof parsed.reduceMotion === "boolean") {
            manualReduceMotion.current = parsed.reduceMotion;
          }
          if (typeof parsed.reduceTransparency === "boolean") {
            manualReduceTransparency.current = parsed.reduceTransparency;
          }
        }
      } catch {
        // use defaults
      }

      // Respect system settings if user hasn't explicitly set one
      try {
        const systemReduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
        if (manualReduceMotion.current === null) {
          loaded.reduceMotion = systemReduceMotion;
        }
      } catch {
        // ignore
      }

      try {
        const systemReduceTransparency = await readSystemReduceTransparency();
        if (
          systemReduceTransparency !== null &&
          manualReduceTransparency.current === null
        ) {
          loaded.reduceTransparency = systemReduceTransparency;
        }
      } catch {
        // ignore
      }

      if (!cancelled) setPrefs(loaded);
    })();

    // Listen for system reduce-motion changes
    const reduceMotionSub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (enabled) => {
        setPrefs((prev) => {
          if (manualReduceMotion.current !== null) {
            return prev;
          }
          return { ...prev, reduceMotion: enabled };
        });
      },
    );

    // Listen for system reduce-transparency changes (iOS only fires them;
    // the other platforms hand back an inert subscription)
    const reduceTransparencySub = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (enabled) => {
        setPrefs((prev) => {
          if (manualReduceTransparency.current !== null) {
            return prev;
          }
          return { ...prev, reduceTransparency: enabled };
        });
      },
    );

    return () => {
      cancelled = true;
      reduceMotionSub.remove();
      reduceTransparencySub.remove();
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const persist = useCallback((next: AccessibilityPrefs) => {
    pendingPersistence.current = next;
    const requestId = ++persistenceRequestId.current;
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      .then(() => {
        if (persistenceRequestId.current !== requestId) return;
        pendingPersistence.current = null;
        if (mounted.current) setPersistenceError(null);
      })
      .catch(() => {
        if (persistenceRequestId.current !== requestId) return;
        if (mounted.current) {
          setPersistenceError(
            "Your accessibility preference changed, but could not be saved. Retry saving preferences.",
          );
        }
      });
  }, []);

  const retryPersistence = useCallback(async () => {
    const next = pendingPersistence.current;
    if (!next) return true;

    const requestId = ++persistenceRequestId.current;
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      if (persistenceRequestId.current !== requestId) return false;
      pendingPersistence.current = null;
      if (mounted.current) setPersistenceError(null);
      return true;
    } catch {
      if (persistenceRequestId.current === requestId && mounted.current) {
        setPersistenceError(
          "Your accessibility preference changed, but could not be saved. Retry saving preferences.",
        );
      }
      return false;
    }
  }, []);

  const setHighContrast = useCallback(
    (v: boolean) => {
      setPrefs((prev) => {
        const next = { ...prev, highContrast: v };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const setFontScale = useCallback(
    (v: FontScale) => {
      setPrefs((prev) => {
        const next = { ...prev, fontScale: v };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const setReduceMotion = useCallback(
    (v: boolean) => {
      manualReduceMotion.current = v;
      setPrefs((prev) => {
        const next = { ...prev, reduceMotion: v };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const setReduceTransparency = useCallback(
    (v: boolean) => {
      manualReduceTransparency.current = v;
      setPrefs((prev) => {
        const next = { ...prev, reduceTransparency: v };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  return (
    <AccessibilityContext.Provider
      value={{
        ...prefs,
        setHighContrast,
        setFontScale,
        setReduceMotion,
        setReduceTransparency,
        persistenceError,
        retryPersistence,
      }}
    >
      <View style={styles.root}>
        {children}
        {persistenceError ? (
          <View style={styles.persistenceAlert}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={styles.persistenceMessage}
            >
              {persistenceError}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry saving accessibility preferences"
              onPress={() => void retryPersistence()}
              style={styles.retryButton}
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility(): AccessibilityContextValue {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) throw new Error("useAccessibility must be inside AccessibilityProvider");
  return ctx;
}

export function useAccessibilityOptional(): AccessibilityContextValue {
  return useContext(AccessibilityContext) ?? {
    ...defaults,
    setHighContrast: () => undefined,
    setFontScale: () => undefined,
    setReduceMotion: () => undefined,
    setReduceTransparency: () => undefined,
    persistenceError: null,
    retryPersistence: async () => true,
  };
}

/**
 * Text primitives use this optional form so they can safely render in
 * standalone previews and tests while still following the provider in the
 * app. The provider is present around all production routes.
 */
export function useFontScale(): FontScale {
  return useContext(AccessibilityContext)?.fontScale ?? defaults.fontScale;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  persistenceAlert: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#7f1d1d",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  persistenceMessage: {
    flex: 1,
    color: "#fff",
    fontSize: 14,
    lineHeight: 19,
  },
  retryButton: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 7,
    backgroundColor: "#fff",
  },
  retryButtonText: {
    color: "#7f1d1d",
    fontSize: 14,
    fontWeight: "700",
  },
});
