import React from "react";
import { StyleSheet, View } from "react-native";

import { ScaledText as Text } from "@/components/ScaledText";
import { useColors } from "@/hooks/useColors";

export function AppFooter() {
  const colors = useColors();
  const currentYear = new Date().getFullYear();

  return (
    <View
      style={[
        styles.footer,
        {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
        },
      ]}
    >
      <Text style={[styles.text, { color: colors.mutedForeground }]}>
        © {currentYear} Lisa M Gorewit-Decker
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: {
    fontSize: 11,
    textAlign: "center",
  },
});