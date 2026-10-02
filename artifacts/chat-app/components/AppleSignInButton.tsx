import React from "react";
import { FontAwesome } from "@expo/vector-icons";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ScaledText as Text } from "@/components/ScaledText";
import { useColors } from "@/hooks/useColors";

// App Store Review Guideline 4.8 requires Sign in with Apple wherever other
// third-party social login is offered, and Apple's Human Interface Guidelines
// require the button to carry the Apple mark on Apple's black with white
// lettering. This shared component keeps both auth screens compliant; the
// generic bordered OAuth style used for Google and X is not sufficient.
export function AppleSignInButton({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Continue with Apple"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { borderColor: colors.border, borderRadius: colors.radius },
      ]}
    >
      <View style={styles.content}>
        <FontAwesome name="apple" size={20} color="#FFFFFF" style={styles.icon} />
        <Text style={styles.text}>Continue with Apple</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000000",
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: { marginRight: 8 },
  text: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", textAlign: "center" },
});
