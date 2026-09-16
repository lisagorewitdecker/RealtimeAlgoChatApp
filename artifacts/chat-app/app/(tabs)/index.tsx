import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import RoomCard from "@/components/RoomCard";
import { PRODUCT_NAME } from "@/constants/branding";
import { useApp } from "@/contexts/AppContext";
import { ScaledText as Text } from "@/components/ScaledText";
import { useColors } from "@/hooks/useColors";

interface Room {
  id: string;
  name: string;
  userCount: number;
  createdAt: number;
}

export default function ChatsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { username } = useApp();
  const { getToken } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const getTokenRef = useRef(getToken);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const fetchRooms = useCallback(async () => {
    try {
      const domain = process.env["EXPO_PUBLIC_DOMAIN"];
      const base = domain ? `https://${domain}` : "http://localhost:5000";
      const token = await getTokenRef.current();
      if (!token) return;
      const res = await fetch(`${base}/api/rooms`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRooms(data.rooms ?? []);
      }
    } catch (_) {
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchRooms();
    intervalRef.current = setInterval(fetchRooms, 8000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchRooms]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchRooms();
  }, [fetchRooms]);

  function handleJoin(room: Room) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/room/${room.id}?roomName=${encodeURIComponent(room.name)}`);
  }

  const topPad =
    Platform.OS === "web" ? 67 : insets.top;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: topPad + 14,
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {PRODUCT_NAME}
          </Text>
          <Text
            accessibilityRole="header"
            {...{ role: "heading", "aria-level": 2 }}
            style={[styles.greeting, { color: colors.foreground }]}
          >
            welcome back
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {username ? `Hi, ${username}` : "Tap + to join a room"}
          </Text>
        </View>
        <TouchableOpacity
          style={[
            styles.newBtn,
            { backgroundColor: colors.primary, borderRadius: colors.radius },
          ]}
          onPress={() => router.push("/new-room")}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Create or join a room"
          testID="new-room-button"
        >
          <Feather name="plus" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : rooms.length === 0 ? (
        <View style={styles.center}>
          <Feather name="message-square" size={48} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            No active rooms
          </Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            Create one to get started
          </Text>
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <RoomCard room={item} onPress={() => handleJoin(item)} />
          )}
          contentContainerStyle={{ paddingTop: 16, paddingBottom: insets.bottom + 90 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
        />
      )}
      <View
        style={[
          styles.footer,
          {
            borderTopColor: colors.border,
            paddingBottom: insets.bottom + (Platform.OS === "web" ? 84 : 64),
          },
        ]}
      >
        <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
          Copyright, Lisa M Gorewit-Decker
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 28, fontWeight: "800" as const, flexShrink: 1, lineHeight: 34 },
  greeting: { fontSize: 20, fontWeight: "600" as const, marginTop: 4 },
  subtitle: { fontSize: 13, marginTop: 2 },
  newBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "700" as const, marginTop: 8 },
  emptyText: { fontSize: 14 },
  footer: {
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  footerText: { fontSize: 11, textAlign: "center" },
});
