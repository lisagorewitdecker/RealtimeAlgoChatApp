import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RoomKeyPersistenceError, useCrypto } from "@/contexts/CryptoContext";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput as TextInput } from "@/components/ScaledTextInput";
import { useColors } from "@/hooks/useColors";

interface PendingRoom {
  id: string;
  name: string;
}

export default function NewRoomScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    generateRoomKey,
    getRoomKey,
    retryRoomKeyPersistence,
    roomKeyPersistenceFailures,
  } = useCrypto();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [roomName, setRoomName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [pendingRoom, setPendingRoom] = useState<PendingRoom | null>(null);
  const [isSavingRoomKey, setIsSavingRoomKey] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  async function handleSubmit() {
    if (mode === "create") {
      const name = roomName.trim();
      if (name.length < 2) return;
      const room =
        pendingRoom?.name === name
          ? pendingRoom
          : {
              id:
                name.toLowerCase().replace(/\s+/g, "-") +
                "-" +
                Math.random().toString(36).slice(2, 6),
              name,
            };
      setPendingRoom(room);
      setIsSavingRoomKey(true);
      setSetupError(null);
      try {
        if (getRoomKey(room.id)) {
          if (!(await retryRoomKeyPersistence(room.id))) return;
        } else {
          await generateRoomKey(room.id);
        }
        setPendingRoom(null);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        router.push(
          `/room/${encodeURIComponent(room.id)}?roomName=${encodeURIComponent(name)}&create=true`
        );
      } catch (error) {
        if (!(error instanceof RoomKeyPersistenceError)) {
          setSetupError(
            "The encrypted room could not be prepared. Return to the room list and try again.",
          );
        } else if (error.reason === "identity_changed") {
          setSetupError(
            "Your active account changed while the key was being saved. Confirm the current account, then retry.",
          );
        }
      } finally {
        setIsSavingRoomKey(false);
      }
    } else {
      const id = roomId.trim();
      if (id.length < 2) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(`/room/${encodeURIComponent(id)}`);
    }
  }

  const pendingPersistenceFailure = pendingRoom
    ? roomKeyPersistenceFailures.get(pendingRoom.id)
    : undefined;

  return (
    <KeyboardAwareScrollViewCompat
      testID="new-room-scroll"
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.inner,
        {
          paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 16,
          paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 24,
        },
      ]}
      bottomOffset={72}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <>
        <View style={styles.headerRow}>
          <TouchableOpacity
            testID="new-room-back-button"
            accessibilityRole="button"
            accessibilityLabel="Close new room"
            onPress={() => router.back()}
            hitSlop={12}
          >
            <Feather name="arrow-left" size={24} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>New Room</Text>
          <View style={{ width: 24 }} />
        </View>

        <View
          style={[
            styles.toggle,
            { backgroundColor: colors.secondary, borderRadius: colors.radius },
          ]}
        >
          {(["create", "join"] as const).map((m) => (
            <TouchableOpacity
              key={m}
              testID={`new-room-mode-${m}`}
              style={[
                styles.toggleOption,
                {
                  backgroundColor: mode === m ? colors.primary : "transparent",
                  borderRadius: colors.radius - 2,
                },
              ]}
              onPress={() => setMode(m)}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.toggleText,
                  { color: mode === m ? colors.primaryForeground : colors.mutedForeground },
                ]}
              >
                {m === "create" ? "Create" : "Join"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {mode === "create" ? (
          <View style={styles.form}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              ROOM NAME
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.foreground,
                  borderColor: colors.border,
                  borderRadius: colors.radius,
                },
              ]}
              placeholder="e.g. Design Team"
              placeholderTextColor={colors.mutedForeground}
              value={roomName}
              onChangeText={setRoomName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
              maxLength={40}
              accessibilityLabel="Room name"
              testID="room-name-input"
            />
          </View>
        ) : (
          <View style={styles.form}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              ROOM ID
            </Text>
            <TextInput
              testID="room-id-input"
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.foreground,
                  borderColor: colors.border,
                  borderRadius: colors.radius,
                },
              ]}
              placeholder="e.g. design-team-a3b2"
              placeholderTextColor={colors.mutedForeground}
              value={roomId}
              onChangeText={setRoomId}
              autoFocus
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
              maxLength={80}
            />
          </View>
        )}

        {pendingPersistenceFailure ? (
          <View
            testID="new-room-key-storage-warning"
            accessibilityRole="alert"
            style={[
              styles.warning,
              {
                backgroundColor: `${colors.destructive}14`,
                borderColor: colors.destructive,
                borderRadius: colors.radius,
              },
            ]}
          >
            <Feather name="alert-triangle" size={20} color={colors.destructive} />
            <View style={styles.warningCopy}>
              <Text style={[styles.warningTitle, { color: colors.foreground }]}>
                Room key could not be saved
              </Text>
              <Text style={[styles.warningText, { color: colors.mutedForeground }]}>
                Make secure storage available, then retry. The room will not open
                until its encryption key is safely stored.
              </Text>
            </View>
          </View>
        ) : null}

        {setupError ? (
          <View
            testID="new-room-key-setup-error"
            accessibilityRole="alert"
            style={[
              styles.warning,
              {
                backgroundColor: `${colors.destructive}14`,
                borderColor: colors.destructive,
                borderRadius: colors.radius,
              },
            ]}
          >
            <Feather name="alert-triangle" size={20} color={colors.destructive} />
            <Text style={[styles.warningText, styles.warningCopy, { color: colors.foreground }]}>
              {setupError}
            </Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[
            styles.btn,
            {
              backgroundColor:
                (mode === "create" ? roomName.trim().length >= 2 : roomId.trim().length >= 2)
                  ? colors.primary
                  : colors.muted,
              borderRadius: colors.radius,
            },
          ]}
          onPress={() => void handleSubmit()}
          disabled={isSavingRoomKey}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={mode === "create" ? "Create room" : "Join room"}
          testID="room-submit-button"
        >
          <Feather
            name={mode === "create" ? "plus-circle" : "log-in"}
            size={20}
            color={
              (mode === "create" ? roomName.trim().length >= 2 : roomId.trim().length >= 2)
                ? colors.primaryForeground
                : colors.mutedForeground
            }
          />
          <Text
            style={[
              styles.btnText,
              {
                color:
                  (mode === "create" ? roomName.trim().length >= 2 : roomId.trim().length >= 2)
                    ? colors.primaryForeground
                    : colors.mutedForeground,
              },
            ]}
          >
            {mode === "create"
              ? isSavingRoomKey
                ? "Saving encryption key…"
                : pendingPersistenceFailure
                  ? "Retry creating room"
                  : "Create Room"
              : "Join Room"}
          </Text>
        </TouchableOpacity>
      </>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { flexGrow: 1, paddingHorizontal: 24, gap: 24 },
  headerRow: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between", marginBottom: 4,
  },
  title: { fontSize: 20, fontWeight: "700" as const },
  toggle: { flexDirection: "row", padding: 4, minHeight: 48 },
  toggleOption: {
    flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 8,
  },
  toggleText: { fontSize: 15, fontWeight: "700" as const, textAlign: "center" },
  form: { gap: 10 },
  warning: {
    alignItems: "flex-start",
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14,
  },
  warningCopy: { flex: 1 },
  warningTitle: { fontSize: 14, fontWeight: "700" as const },
  warningText: { fontSize: 13, lineHeight: 19, marginTop: 3 },
  label: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.8 },
  input: {
    minHeight: 52, paddingHorizontal: 16, paddingVertical: 12,
    fontSize: 16, borderWidth: 1.5,
  },
  btn: {
    minHeight: 54, flexDirection: "row", alignItems: "center",
    justifyContent: "center", gap: 10, marginTop: 8,
    paddingHorizontal: 12, paddingVertical: 12,
  },
  btnText: { fontSize: 16, fontWeight: "700" as const, textAlign: "center", flexShrink: 1 },
});
