import { useRouter } from "expo-router";
import React, { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { ScaledText as Text } from "@/components/ScaledText";
import { useAccessibility } from "@/contexts/AccessibilityContext";
import { useColors } from "@/hooks/useColors";

/**
 * Gives the native release smoke test a public, deterministic way to enable
 * the same preferences a user selects in Profile before authentication.
 * There is no auth bypass or mock data here; it only persists UI preferences.
 */
export default function NativeSmokePreferencesScreen() {
  const colors = useColors();
  const router = useRouter();
  const { setFontScale, setHighContrast, setReduceMotion } = useAccessibility();

  useEffect(() => {
    setFontScale(1.4);
    setHighContrast(true);
    setReduceMotion(true);
    router.replace("/(auth)/sign-in" as never);
  }, [router, setFontScale, setHighContrast, setReduceMotion]);

  return (
    <View
      accessibilityRole="progressbar"
      style={[styles.root, { backgroundColor: colors.background }]}
    >
      <ActivityIndicator color={colors.primary} />
      <Text style={[styles.copy, { color: colors.mutedForeground }]}>
        Preparing accessibility smoke test…
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  copy: {
    fontSize: 14,
    textAlign: "center",
  },
});