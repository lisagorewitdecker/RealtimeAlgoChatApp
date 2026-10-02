/**
 * Admin Room Manager — lists all rooms with stats and lets the admin
 * deactivate (soft-hide) or permanently delete them.
 * Only reachable/useful when EXPO_PUBLIC_ADMIN_USER_IDS includes the signed-in user.
 */
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScaledText as Text } from "@/components/ScaledText";
import { useColors } from "@/hooks/useColors";

interface AdminRoom {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  isActive: boolean;
  memberCount: number;
  lastActivityAt: number | null;
}

const BASE = process.env["EXPO_PUBLIC_DOMAIN"]
  ? `https://${process.env["EXPO_PUBLIC_DOMAIN"]}`
  : "http://localhost:5000";

function formatDate(ts: number | null) {
  if (!ts) return "No messages";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export default function AdminRoomsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { getToken } = useAuth();

  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const apiFetch = useCallback(
    async (path: string, method = "GET", body?: object) => {
      const token = await getToken();
      const res = await fetch(`${BASE}/api/admin/${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return res;
    },
    [getToken],
  );

  const loadRooms = useCallback(async () => {
    try {
      const res = await apiFetch("rooms");
      if (res.ok) {
        const data = await res.json();
        setRooms(data.rooms ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadRooms();
  }, [loadRooms]);

  const deactivateRoom = useCallback(
    async (room: AdminRoom) => {
      setActionInProgress(room.id);
      try {
        const res = await apiFetch(`rooms/${encodeURIComponent(room.id)}/deactivate`, "PATCH");
        if (res.ok) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setRooms((prev) =>
            prev.map((r) => (r.id === room.id ? { ...r, isActive: false } : r)),
          );
        }
      } finally {
        setActionInProgress(null);
      }
    },
    [apiFetch],
  );

  const reactivateRoom = useCallback(
    async (room: AdminRoom) => {
      setActionInProgress(room.id);
      try {
        const res = await apiFetch(`rooms/${encodeURIComponent(room.id)}/reactivate`, "PATCH");
        if (res.ok) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setRooms((prev) =>
            prev.map((r) => (r.id === room.id ? { ...r, isActive: true } : r)),
          );
        }
      } finally {
        setActionInProgress(null);
      }
    },
    [apiFetch],
  );

  const deleteRoom = useCallback(
    (room: AdminRoom) => {
      const doDelete = async () => {
        setActionInProgress(room.id);
        try {
          const res = await apiFetch(`rooms/${encodeURIComponent(room.id)}`, "DELETE");
          if (res.ok) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setRooms((prev) => prev.filter((r) => r.id !== room.id));
          } else {
            Alert.alert("Error", "Failed to delete room.");
          }
        } finally {
          setActionInProgress(null);
        }
      };

      Alert.alert(
        "Delete room permanently?",
        `"${room.name}" and all its messages will be permanently removed. This cannot be undone.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => void doDelete() },
        ],
      );
    },
    [apiFetch],
  );

  const handleRoomAction = useCallback(
    (room: AdminRoom) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const options = room.isActive
        ? ["Cancel", "Deactivate (hide from users)", "Delete permanently"]
        : ["Cancel", "Reactivate", "Delete permanently"];

      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: room.name,
            message: `${room.memberCount} members · Last active: ${formatDate(room.lastActivityAt)}`,
            options,
            destructiveButtonIndex: 2,
            cancelButtonIndex: 0,
          },
          (idx) => {
            if (idx === 1) {
              if (room.isActive) void deactivateRoom(room);
              else void reactivateRoom(room);
            }
            if (idx === 2) deleteRoom(room);
          },
        );
      } else {
        Alert.alert(room.name, `${room.memberCount} members · Last active: ${formatDate(room.lastActivityAt)}`, [
          { text: "Cancel", style: "cancel" },
          room.isActive
            ? { text: "Deactivate", onPress: () => void deactivateRoom(room) }
            : { text: "Reactivate", onPress: () => void reactivateRoom(room) },
          { text: "Delete permanently", style: "destructive", onPress: () => deleteRoom(room) },
        ]);
      }
    },
    [deactivateRoom, reactivateRoom, deleteRoom],
  );

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const renderItem = ({ item }: { item: AdminRoom }) => {
    const isBusy = actionInProgress === item.id;
    const isInactive = !item.isActive;
    const daysSinceActivity = item.lastActivityAt
      ? Math.floor((Date.now() - item.lastActivityAt) / 86400000)
      : null;
    const isStale = daysSinceActivity !== null && daysSinceActivity > 30;

    return (
      <TouchableOpacity
        style={[
          styles.roomCard,
          {
            backgroundColor: colors.card,
            borderColor: isInactive
              ? colors.destructive + "40"
              : isStale
              ? colors.mutedForeground + "30"
              : colors.border,
            borderRadius: colors.radius,
            opacity: isInactive ? 0.9 : 1,
          },
        ]}
        onPress={() => handleRoomAction(item)}
        activeOpacity={0.75}
        disabled={isBusy}
        accessibilityLabel={`${item.name}. ${item.memberCount} members. Last active ${formatDate(item.lastActivityAt)}. Tap for actions.`}
        accessibilityRole="button"
      >
        <View style={styles.roomCardMain}>
          <View style={styles.roomCardLeft}>
            {isInactive && (
              <View style={[styles.inactivePill, { backgroundColor: colors.destructive + "20" }]}>
                <Text style={[styles.inactivePillText, { color: colors.destructive, fontSize: 10 }]}>
                  HIDDEN
                </Text>
              </View>
            )}
            {isStale && !isInactive && (
              <View style={[styles.inactivePill, { backgroundColor: colors.mutedForeground + "20" }]}>
                <Text style={[styles.inactivePillText, { color: colors.mutedForeground, fontSize: 10 }]}>
                  STALE
                </Text>
              </View>
            )}
            <Text
              style={[styles.roomName, { color: colors.foreground, fontSize: 15 }]}
            >
              {item.name}
            </Text>
            <Text style={[styles.roomMeta, { color: colors.mutedForeground, fontSize: 12 }]}>
              {item.memberCount} {item.memberCount === 1 ? "member" : "members"} ·{" "}
              {formatDate(item.lastActivityAt)}
            </Text>
            <Text
              style={[styles.roomId, { color: colors.mutedForeground, fontSize: 10 }]}
            >
              ID: {item.id}
            </Text>
          </View>
          <View style={styles.roomCardRight}>
            {isBusy ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Feather name="more-vertical" size={18} color={colors.mutedForeground} />
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border },
        ]}
        accessible
        accessibilityRole="header"
      >
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <View style={styles.headerTitleRow}>
            <Feather name="shield" size={14} color={colors.primary} />
            <Text style={[styles.headerTitle, { color: colors.foreground, fontSize: 17 }]}>
              Room Manager
            </Text>
          </View>
          <Text style={[styles.headerSub, { color: colors.mutedForeground, fontSize: 12 }]}>
            {rooms.length} room{rooms.length !== 1 ? "s" : ""} total
          </Text>
        </View>
        <TouchableOpacity
          onPress={onRefresh}
          hitSlop={10}
          accessibilityLabel="Refresh rooms"
          accessibilityRole="button"
        >
          <Feather name="refresh-cw" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      {/* Legend */}
      <View style={[styles.legend, { backgroundColor: colors.muted, borderBottomColor: colors.border }]}>
        <Feather name="info" size={12} color={colors.mutedForeground} />
        <Text style={[styles.legendText, { color: colors.mutedForeground, fontSize: 11 }]}>
          Tap a room to deactivate (hide) or delete it permanently.
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(r) => r.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Feather name="inbox" size={48} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground, fontSize: 14 }]}>
                No rooms found
              </Text>
            </View>
          }
          accessibilityLabel="Room list"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 16,
    paddingBottom: 12, borderBottomWidth: 1, gap: 12,
  },
  headerCenter: { flex: 1 },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerTitle: { fontWeight: "700" as const },
  headerSub: { marginTop: 2 },
  legend: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1,
  },
  legendText: { flex: 1 },
  list: { padding: 16, gap: 10 },
  roomCard: { borderWidth: 1, padding: 14 },
  roomCardMain: { flexDirection: "row", alignItems: "center", gap: 12 },
  roomCardLeft: { flex: 1, gap: 3 },
  roomCardRight: { width: 24, alignItems: "center" },
  inactivePill: {
    alignSelf: "flex-start", paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4, marginBottom: 2,
  },
  inactivePillText: { fontWeight: "700" as const, letterSpacing: 0.5 },
  roomName: { fontWeight: "600" as const },
  roomMeta: {},
  roomId: { fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  emptyText: {},
});
