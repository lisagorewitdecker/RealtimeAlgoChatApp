import { Feather } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { ScaledText as Text } from "@/components/ScaledText";
import { useColors } from "@/hooks/useColors";

interface Room {
  id: string;
  name: string;
  userCount: number;
  createdAt: number;
}

interface Props {
  room: Room;
  onPress: () => void;
}

export default function RoomCard({ room, onPress }: Props) {
  const colors = useColors();
  return (
    <TouchableOpacity
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Join ${room.name}, ${room.userCount} online`}
      accessibilityHint="Opens this chat room"
      testID={`room-card-${room.id}`}
    >
      <View
        style={[
          styles.icon,
          { backgroundColor: colors.secondary, borderRadius: colors.radius - 2 },
        ]}
      >
        <Feather name="message-circle" size={22} color={colors.primary} />
      </View>
      <View style={styles.info}>
        <Text
          style={[styles.name, { color: colors.foreground }]}
        >
          {room.name}
        </Text>
        <View style={styles.meta}>
          <View
            style={[styles.dot, { backgroundColor: colors.online }]}
          />
          <Text style={[styles.count, { color: colors.mutedForeground }]}>
            {room.userCount} online
          </Text>
        </View>
      </View>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row", alignItems: "center", padding: 14,
    marginHorizontal: 16, marginBottom: 10,
    borderWidth: 1, gap: 12,
  },
  icon: { width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  info: { flex: 1 },
  name: { fontSize: 16, fontWeight: "600" as const, marginBottom: 3 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  count: { fontSize: 12 },
});
