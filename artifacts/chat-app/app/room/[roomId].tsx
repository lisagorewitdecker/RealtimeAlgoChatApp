import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  ActivityIndicator,
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MessageBubble from "@/components/MessageBubble";
import { useApp } from "@/contexts/AppContext";
import { useCrypto } from "@/contexts/CryptoContext";
import { useSocket } from "@/contexts/SocketContext";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput } from "@/components/ScaledTextInput";
import { useColors } from "@/hooks/useColors";
import { Sentry } from "@/lib/sentry";
import { textLengthBucket, trackEvent } from "@/utils/analytics";

interface Message {
  id: string;
  content: string;
  ciphertext?: string;
  nonce?: string;
  userId: string;
  username: string;
  avatarEmoji?: string;
  timestamp: number;
  type: "text" | "system";
  deleted?: boolean;
}

interface User {
  userId: string;
  username: string;
  avatarEmoji?: string;
  publicKey?: string | null;
}

interface RoomKeyEnvelope {
  ciphertext: string;
  nonce: string;
  senderPublicKey: string;
}

function uniqueMessages(messages: Message[]): Message[] {
  const seenIds = new Set<string>();
  return messages.filter((message) => {
    if (seenIds.has(message.id)) return false;
    seenIds.add(message.id);
    return true;
  });
}

function appendMessageById(messages: Message[], message: Message): Message[] {
  return messages.some((existing) => existing.id === message.id)
    ? messages
    : [...messages, message];
}

function apiBaseUrl(): string {
  const domain = process.env["EXPO_PUBLIC_DOMAIN"];
  return domain ? `https://${domain}` : "http://localhost:5000";
}

export default function RoomScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ roomId: string; roomName?: string; create?: string }>();
  const roomId = params.roomId ?? "";
  const roomName = params.roomName ?? roomId;
  const createIfMissing = params.create === "true";

  const { userId } = useApp();
  const { getToken } = useAuth();
  const { socket } = useSocket();
  const {
    publicKeyB64,
    isReady: isCryptoReady,
    deviceKeyStatus,
    isDeviceKeyRegistrationSlow,
    markDeviceKeySuperseded,
    decryptMessage,
    decryptRoomKeyEnvelope,
    encryptMessage,
    encryptRoomKey,
    getRoomKey,
    loadRoomKey,
    setRoomKey,
    roomKeyPersistenceFailures,
    retryRoomKeyPersistence,
  } = useCrypto();

  const [messages, setMessages] = useState<Message[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [text, setText] = useState("");
  const [showUsers, setShowUsers] = useState(false);
  const [canModerate, setCanModerate] = useState(false);
  const [moderatingUserId, setModeratingUserId] = useState<string | null>(null);
  const [roomBanned, setRoomBanned] = useState(false);
  const [roomReady, setRoomReady] = useState(false);
  const [messageReplayGap, setMessageReplayGap] = useState(false);
  const [retryingRoomKey, setRetryingRoomKey] = useState(false);
  const [hasRoomKey, setHasRoomKey] = useState(() => !!getRoomKey(roomId));
  const inputRef = useRef<TextInput>(null);
  const hasTrackedRoomJoin = useRef(false);
  const roomKeyLoadRef = useRef<Promise<void> | null>(null);
  const roomKeyEnvelopeRecoveryRef = useRef<Promise<boolean> | null>(null);
  const reportedPersistenceRetryFailuresRef = useRef(new Set<"save" | "load">());
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const recoveryRequestRef = useRef<string | null>(null);
  const deletionRecoveryCursorRef = useRef({ id: "", deletedAt: Date.now() });
  const deletedMessageIdsRef = useRef(new Set<string>());
  // Mirrors `canModerate` for socket handlers, which must not re-subscribe
  // (and re-join) whenever moderation rights change.
  const canModerateRef = useRef(false);
  canModerateRef.current = canModerate;
  const roomKeyPersistenceFailure = roomKeyPersistenceFailures.get(roomId);

  const decryptIncomingMessage = useCallback(
    (message: Message & { ciphertext?: string; nonce?: string }): Message => {
      if (message.type === "system") {
        return { ...message, content: message.content ?? "" };
      }
      const content =
        message.ciphertext && message.nonce
          ? decryptMessage(message.ciphertext, message.nonce, roomId)
          : null;
      return {
        ...message,
        content: content ?? "Unable to decrypt this message.",
      };
    },
    [decryptMessage, roomId],
  );

  const mergeMessages = useCallback((incoming: Message[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) byId.set(message.id, message);
      const merged = [...byId.values()].sort(
        (left, right) =>
          (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
          left.id.localeCompare(right.id),
      );
      messagesRef.current = merged;
      return merged;
    });
  }, []);

  const acceptRoomKeyEnvelope = useCallback(
    (envelope: RoomKeyEnvelope | null | undefined): Promise<boolean> => {
      if (!envelope || getRoomKey(roomId)) return Promise.resolve(false);
      if (roomKeyEnvelopeRecoveryRef.current) {
        return roomKeyEnvelopeRecoveryRef.current;
      }
      const recovery = (async () => {
        const roomKey = decryptRoomKeyEnvelope(
          envelope.ciphertext,
          envelope.nonce,
          envelope.senderPublicKey,
        );
        if (!roomKey) return false;
        await setRoomKey(roomId, roomKey);
        setHasRoomKey(true);
        // Re-decrypt the current array in place. Messages that arrived while
        // the key was being saved are included without changing order or ids.
        setMessages((current) => current.map(decryptIncomingMessage));
        return true;
      })();
      roomKeyEnvelopeRecoveryRef.current = recovery;
      const clearRecovery = () => {
        if (roomKeyEnvelopeRecoveryRef.current === recovery) {
          roomKeyEnvelopeRecoveryRef.current = null;
        }
      };
      void recovery.then(clearRecovery, clearRecovery);
      return recovery;
    },
    [
      decryptIncomingMessage,
      decryptRoomKeyEnvelope,
      getRoomKey,
      roomId,
      setRoomKey,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    // The join below waits on this promise, so it must always settle: a
    // rejected hydration would otherwise leave the room on "Opening room…".
    const loading = loadRoomKey(roomId).catch((error: unknown) => {
      console.warn(
        "Room key hydration failed",
        error instanceof Error ? error.message : error,
      );
    });
    roomKeyLoadRef.current = loading;
    void loading.then(() => {
      if (!cancelled) setHasRoomKey(!!getRoomKey(roomId));
    });
    return () => {
      cancelled = true;
      roomKeyLoadRef.current = null;
    };
  }, [getRoomKey, loadRoomKey, roomId]);

  const handleRoomBanned = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    setRoomBanned(true);
  }, []);

  useEffect(() => {
    if (roomKeyPersistenceFailure) {
      setRoomReady(false);
      setMessages([]);
      setUsers([]);
      setCanModerate(false);
      return;
    }
    if (!socket || !userId || !isCryptoReady || !publicKeyB64) {
      // Encrypted rooms are only joined with a server-confirmed device key.
      // While the key is missing or being (re)registered, keep the room in its
      // connecting state instead of showing a stale, un-joined conversation.
      setRoomReady(false);
      return;
    }

    let disposed = false;

    // Encrypts this device's copy of the room key to a member's current device
    // key. The server only persists and forwards envelopes from the creator.
    function sendRoomKeyEnvelope(targetUserId: string, targetPublicKey: string) {
      const roomKey = getRoomKey(roomId);
      if (!roomKey || targetUserId === userId) return;
      const envelope = encryptRoomKey(roomKey, targetPublicKey);
      if (!envelope) return;
      socket?.emit("room-key-envelope", {
        roomId,
        targetUserId,
        senderPublicKey: publicKeyB64,
        ciphertext: envelope.ciphertextB64,
        nonce: envelope.nonceB64,
      });
    }

    // Another device or session of this account registered `newPublicKey`
    // and this device's key is now superseded. Before this room closes here,
    // a creator session that still holds the room key hands it to the new
    // key, so the account's fresh device can recover rooms it created. The
    // server accepts this only from the creator and only under the key it
    // recorded as displaced; the envelope is encrypted to the new key, so
    // no room plaintext or private key material is exposed.
    function handOverRoomKey(newPublicKey: string, isCreator: boolean) {
      if (disposed) return;
      const roomKey = getRoomKey(roomId);
      if (isCreator && roomKey) {
        const envelope = encryptRoomKey(roomKey, newPublicKey);
        if (envelope) {
          socket?.emit("room-key-envelope", {
            roomId,
            targetUserId: userId,
            senderPublicKey: publicKeyB64,
            ciphertext: envelope.ciphertextB64,
            nonce: envelope.nonceB64,
          });
        }
      }
      markDeviceKeySuperseded(newPublicKey);
    }

    function onRoomJoined(data: {
      messages: Array<Message & { ciphertext?: string; nonce?: string }>;
      users: User[];
      canModerate?: boolean;
      keyEnvelope?: RoomKeyEnvelope | null;
      replayAfterMessageId?: string;
      replayGap?: boolean;
    }) {
      // The roster carries the key the server holds for every member, this
      // device included. A different key for this account means another
      // device or session took over the registration: fresh room keys would
      // go to that key, so close encrypted rooms here until the user resets.
      const self = data.users.find((member) => member.userId === userId);
      if (self?.publicKey && self.publicKey !== publicKeyB64) {
        const newPublicKey = self.publicKey;
        const isCreator = data.canModerate === true;
        // The saved room key may still be hydrating; the handover needs it.
        if (!getRoomKey(roomId) && roomKeyLoadRef.current) {
          void roomKeyLoadRef.current.then(() => handOverRoomKey(newPublicKey, isCreator));
        } else {
          handOverRoomKey(newPublicKey, isCreator);
        }
        return;
      }
      const finishJoin = () => {
        setRoomReady(true);
        const knownCursor = [...messagesRef.current]
          .reverse()
          .find((message) => message.type === "text");
        const incomingMessages = data.messages
          .filter((message) => !deletedMessageIdsRef.current.has(message.id))
          .map(decryptIncomingMessage);
        if (knownCursor) {
          mergeMessages(incomingMessages);
          const requestId = `${roomId}:${Date.now()}`;
          recoveryRequestRef.current = requestId;
          socket?.emit("recover-messages", {
            requestId,
            roomId,
            afterMessageId: knownCursor.id,
            afterTimestamp: knownCursor.timestamp,
            deletedAfter: deletionRecoveryCursorRef.current.deletedAt,
            deletedAfterId: deletionRecoveryCursorRef.current.id,
          });
        } else {
          const initialMessages = uniqueMessages(incomingMessages);
          messagesRef.current = initialMessages;
          setMessages(initialMessages);
        }
        setMessageReplayGap(data.replayGap === true);
        setUsers(data.users);
        setCanModerate(data.canModerate === true);
        trackEvent("room_joined", {
          entry_mode: createIfMissing ? "create" : "join",
          reconnect: hasTrackedRoomJoin.current,
          initial_message_count: data.messages.length,
          participant_count: data.users.length,
        });
        hasTrackedRoomJoin.current = true;
        for (const member of data.users) {
          if (member.publicKey) sendRoomKeyEnvelope(member.userId, member.publicKey);
        }
      };
      const finishAfterEnvelope = () => {
        if (data.keyEnvelope && !getRoomKey(roomId)) {
          void acceptRoomKeyEnvelope(data.keyEnvelope).then(
            finishJoin,
            () => undefined,
          );
        } else {
          finishJoin();
        }
      };
      if (!getRoomKey(roomId) && roomKeyLoadRef.current) {
        void roomKeyLoadRef.current.then(finishAfterEnvelope);
        return;
      }
      finishAfterEnvelope();
    }
    function onMessage(msg: Message & { ciphertext?: string; nonce?: string }) {
      mergeMessages([decryptIncomingMessage(msg)]);
    }
    function onMessageRecoveryPage(data: {
      requestId: string;
      messages: Array<Message & { ciphertext?: string; nonce?: string }>;
      deletedMessageIds?: string[];
      hasMore: boolean;
      nextCursor: { id: string; timestamp: number };
      nextDeletionCursor?: { id: string; deletedAt: number };
    }) {
      if (data.requestId !== recoveryRequestRef.current) return;
      const deletedIds = new Set(data.deletedMessageIds ?? []);
      for (const id of deletedIds) deletedMessageIdsRef.current.add(id);
      setMessages((current) => {
        const retained = current.filter((message) => !deletedIds.has(message.id));
        const byId = new Map(retained.map((message) => [message.id, message]));
        for (const message of data.messages.map(decryptIncomingMessage)) {
          if (!deletedMessageIdsRef.current.has(message.id)) {
            byId.set(message.id, message);
          }
        }
        const merged = [...byId.values()].sort(
          (left, right) =>
            (left.timestamp ?? 0) - (right.timestamp ?? 0) ||
            left.id.localeCompare(right.id),
        );
        messagesRef.current = merged;
        return merged;
      });
      if (data.nextDeletionCursor) {
        deletionRecoveryCursorRef.current = data.nextDeletionCursor;
      }
      if (data.hasMore) {
        const requestId = `${roomId}:${Date.now()}:${data.nextCursor.id}`;
        recoveryRequestRef.current = requestId;
        socket?.emit("recover-messages", {
          requestId,
          roomId,
          afterMessageId: data.nextCursor.id,
          afterTimestamp: data.nextCursor.timestamp,
            deletedAfter: deletionRecoveryCursorRef.current.deletedAt,
            deletedAfterId: deletionRecoveryCursorRef.current.id,
        });
      } else {
        recoveryRequestRef.current = null;
      }
    }
    function onMessageRecoveryError(data: { requestId?: string }) {
      if (data.requestId === recoveryRequestRef.current) {
        recoveryRequestRef.current = null;
      }
    }
    function onMessageDeleted(data: { roomId?: string; messageId?: string }) {
      if (data.roomId !== roomId || !data.messageId) return;
      deletedMessageIdsRef.current.add(data.messageId);
      setMessages((current) => {
        const retained = current.filter((message) => message.id !== data.messageId);
        messagesRef.current = retained;
        return retained;
      });
    }
    function onUserJoined(data: {
      userId: string;
      username: string;
      avatarEmoji?: string;
      publicKey?: string | null;
      message: Message;
    }) {
      setUsers((prev) => {
        if (prev.find((u) => u.userId === data.userId)) return prev;
        return [
          ...prev,
          { userId: data.userId, username: data.username, avatarEmoji: data.avatarEmoji },
        ];
      });
      setMessages((prev) => appendMessageById(prev, data.message));
      if (data.publicKey) sendRoomKeyEnvelope(data.userId, data.publicKey);
    }
    function onUserKeyChanged(data: {
      roomId?: string;
      userId: string;
      publicKey?: string | null;
    }) {
      // A member re-registered a new device key while another session of
      // theirs kept the room presence alive, so no `user-joined` arrives. The
      // envelope stored for them targets the old key; deliver a fresh one.
      if (data.roomId !== roomId) return;
      if (data.userId === userId) {
        // Another session of this account registered a new key while this
        // device was in the room; this device's key no longer receives keys.
        if (data.publicKey && data.publicKey !== publicKeyB64) {
          handOverRoomKey(data.publicKey, canModerateRef.current);
        }
        return;
      }
      setUsers((prev) =>
        prev.map((member) =>
          member.userId === data.userId ? { ...member, publicKey: data.publicKey } : member,
        ),
      );
      if (data.publicKey) sendRoomKeyEnvelope(data.userId, data.publicKey);
    }
    function onUserLeft(data: { userId: string; message: Message }) {
      setUsers((prev) => prev.filter((u) => u.userId !== data.userId));
      setMessages((prev) => appendMessageById(prev, data.message));
    }
    function onKicked(data: {
      roomId: string;
      userId: string;
      banned?: boolean;
    }) {
      if (data.roomId !== roomId || data.userId !== userId) return;
      if (data.banned) {
        handleRoomBanned();
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Removed", "You have been removed from this room.", [
        { text: "OK", onPress: () => router.replace("/(tabs)" as never) },
      ]);
    }
    function onSocketError(error: { code?: string }) {
      if (error.code === "ROOM_BANNED") {
        handleRoomBanned();
      }
    }
    function onRoomBanned(data: { roomId?: string }) {
      if (data.roomId !== roomId) return;
      handleRoomBanned();
    }
    function onRoomKeyEnvelope(data: RoomKeyEnvelope & { roomId?: string }) {
      if (data.roomId === roomId) {
        // Persistence failures are exposed by CryptoContext through
        // roomKeyPersistenceFailures. This listener is intentionally
        // fire-and-forget, so consume the matching rejection here while the
        // screen switches to its existing retry warning.
        void acceptRoomKeyEnvelope(data).catch(() => undefined);
      }
    }

    const joinRoom = () => {
      const lastSeenMessageId = messagesRef.current.at(-1)?.id;
      socket.emit("join-room", {
        roomId,
        createIfMissing: createIfMissing !== false,
        roomName,
        ...(lastSeenMessageId ? { lastSeenMessageId } : {}),
      });
    };

    socket.on("connect", joinRoom);
    socket.on("room-joined", onRoomJoined);
    socket.on("message", onMessage);
    socket.on("message-recovery-page", onMessageRecoveryPage);
    socket.on("message-recovery-error", onMessageRecoveryError);
    socket.on("message-deleted", onMessageDeleted);
    socket.on("user-joined", onUserJoined);
    socket.on("user-key-changed", onUserKeyChanged);
    socket.on("user-left", onUserLeft);
    socket.on("kicked", onKicked);
    socket.on("error", onSocketError);
    socket.on("room-banned", onRoomBanned);
    socket.on("room-key-envelope", onRoomKeyEnvelope);
    if (socket.connected) joinRoom();

    return () => {
      disposed = true;
      socket.off("connect", joinRoom);
      socket.off("room-joined", onRoomJoined);
      socket.off("message", onMessage);
      socket.off("message-recovery-page", onMessageRecoveryPage);
      socket.off("message-recovery-error", onMessageRecoveryError);
      socket.off("message-deleted", onMessageDeleted);
      socket.off("user-joined", onUserJoined);
      socket.off("user-key-changed", onUserKeyChanged);
      socket.off("user-left", onUserLeft);
      socket.off("kicked", onKicked);
      socket.off("error", onSocketError);
      socket.off("room-banned", onRoomBanned);
      socket.off("room-key-envelope", onRoomKeyEnvelope);
      socket.emit("leave-room", { roomId });
    };
  }, [
    socket,
    userId,
    isCryptoReady,
    roomId,
    roomName,
    createIfMissing,
    handleRoomBanned,
    acceptRoomKeyEnvelope,
    decryptIncomingMessage,
    mergeMessages,
    encryptRoomKey,
    getRoomKey,
    markDeviceKeySuperseded,
    publicKeyB64,
    roomKeyPersistenceFailure,
    router,
  ]);

  const banUser = useCallback(
    async (target: User) => {
      setModeratingUserId(target.userId);
      try {
        const token = await getToken();
        const response = await fetch(
          `${apiBaseUrl()}/api/moderation/${encodeURIComponent(roomId)}/ban`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ userId: target.userId }),
          },
        );
        const result = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!response.ok) {
          throw new Error(result?.error ?? "Unable to ban this room member.");
        }
        trackEvent("moderation_action_completed", {
          action: "ban_room_member",
        });
      } catch (error) {
        Alert.alert(
          "Unable to ban member",
          error instanceof Error ? error.message : "Please try again.",
        );
      } finally {
        setModeratingUserId(null);
      }
    },
    [getToken, roomId],
  );

  const confirmBanUser = useCallback(
    (target: User) => {
      const message = `${target.username} will be removed and will not be able to rejoin this room.`;
      if (Platform.OS === "web") {
        if (globalThis.confirm(`Ban room member?\n\n${message}`)) {
          void banUser(target);
        }
        return;
      }
      Alert.alert(
        "Ban room member?",
        message,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Ban",
            style: "destructive",
            onPress: () => void banUser(target),
          },
        ],
      );
    },
    [banUser],
  );

  const sendMessage = useCallback(() => {
    const content = text.trim();
    if (!content || !socket || roomKeyPersistenceFailure) return;
    const encrypted = encryptMessage(content, roomId);
    if (!encrypted) {
      Alert.alert(
        "Encryption key unavailable",
        "Wait for this room's encryption key before sending a message.",
      );
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    socket.emit("message", {
      roomId,
      ciphertext: encrypted.ciphertextB64,
      nonce: encrypted.nonceB64,
    });
    trackEvent("message_sent", {
      length_bucket: textLengthBucket(content),
    });
    setText("");
  }, [encryptMessage, roomKeyPersistenceFailure, text, socket, roomId]);

  const deleteRoomMessage = useCallback(
    async (messageId: string) => {
      try {
        const token = await getToken();
        const response = await fetch(
          `${apiBaseUrl()}/api/moderation/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token ?? ""}` },
          },
        );
        if (!response.ok) throw new Error("Unable to delete this message.");
      } catch (error) {
        Alert.alert(
          "Unable to delete message",
          error instanceof Error ? error.message : "Please try again.",
        );
      }
    },
    [getToken, roomId],
  );

  const confirmDeleteMessage = useCallback(
    (messageId: string) => {
      if (Platform.OS === "web") {
        if (globalThis.confirm("Delete this message?")) void deleteRoomMessage(messageId);
        return;
      }
      Alert.alert("Delete message?", "This removes the message for everyone.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void deleteRoomMessage(messageId),
        },
      ]);
    },
    [deleteRoomMessage],
  );

  const retrySavingRoomKey = useCallback(async () => {
    const reportRetryFailure = () => {
      const recoveryOperation =
        roomKeyPersistenceFailure?.kind === "load" ? "load" : "save";
      if (!reportedPersistenceRetryFailuresRef.current.has(recoveryOperation)) {
        reportedPersistenceRetryFailuresRef.current.add(recoveryOperation);
        Sentry.captureMessage("Room key persistence retry failed", {
          level: "warning",
          tags: { recovery_operation: recoveryOperation },
        });
      }
    };

    setRetryingRoomKey(true);
    try {
      const persisted = await retryRoomKeyPersistence(roomId);
      if (persisted) {
        setHasRoomKey(!!getRoomKey(roomId));
      } else {
        reportRetryFailure();
      }
    } catch {
      reportRetryFailure();
      // The persistence failure remains in context so the warning stays visible
      // and the user can retry again after secure storage becomes available.
    } finally {
      setRetryingRoomKey(false);
    }
  }, [
    getRoomKey,
    retryRoomKeyPersistence,
    roomId,
    roomKeyPersistenceFailure?.kind,
  ]);

  const openCall = useCallback(() => {
    if (roomKeyPersistenceFailure) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    trackEvent("call_opened", { platform: Platform.OS });
    router.push(
      `/call/${encodeURIComponent(roomId)}?roomName=${encodeURIComponent(roomName)}`
    );
  }, [roomKeyPersistenceFailure, router, roomId, roomName]);

  const openSandbox = useCallback(() => {
    if (roomKeyPersistenceFailure || !hasRoomKey) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    trackEvent("sandbox_opened", { platform: Platform.OS });
    router.push(
      `/sandbox/${encodeURIComponent(roomId)}?roomName=${encodeURIComponent(roomName)}`
    );
  }, [hasRoomKey, roomKeyPersistenceFailure, router, roomId, roomName]);

  const headerTop = Platform.OS === "web" ? 67 : insets.top;

  if (roomBanned) {
    return (
      <View
        testID="banned-room"
        accessibilityRole="alert"
        style={[
          styles.blockedRoot,
          {
            backgroundColor: colors.background,
            paddingTop: headerTop + 24,
            paddingBottom: Math.max(insets.bottom, 24),
          },
        ]}
      >
        <Feather name="slash" size={40} color={colors.destructive} />
        <Text
          accessibilityRole="header"
          style={[styles.blockedTitle, { color: colors.foreground }]}
        >
          Banned from room
        </Text>
        <Text
          style={[styles.blockedDescription, { color: colors.mutedForeground }]}
        >
          A room moderator has banned you from this room.
        </Text>
        <TouchableOpacity
          testID="return-to-room-list-button"
          accessibilityRole="button"
          accessibilityLabel="Return to room list"
          onPress={() => router.replace("/(tabs)" as never)}
          style={[styles.blockedButton, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.blockedButtonText}>Return to room list</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (roomKeyPersistenceFailure) {
    const isLoadFailure = roomKeyPersistenceFailure.kind === "load";
    return (
      <View
        testID="room-key-storage-warning"
        accessibilityRole="alert"
        style={[
          styles.blockedRoot,
          {
            backgroundColor: colors.background,
            paddingTop: headerTop + 24,
            paddingBottom: Math.max(insets.bottom, 24),
          },
        ]}
      >
        <Feather name="alert-triangle" size={40} color={colors.destructive} />
        <Text
          accessibilityRole="header"
          style={[styles.blockedTitle, { color: colors.foreground }]}
        >
          {isLoadFailure
            ? "Saved encryption key could not be read"
            : "Encryption key not saved"}
        </Text>
        <Text style={[styles.blockedDescription, { color: colors.mutedForeground }]}>
          {roomKeyPersistenceFailure.message}
        </Text>
        <TouchableOpacity
          testID="retry-room-key-save-button"
          accessibilityRole="button"
          accessibilityLabel={
            isLoadFailure
              ? "Retry reading room encryption key"
              : "Retry saving room encryption key"
          }
          disabled={retryingRoomKey}
          onPress={() => void retrySavingRoomKey()}
          style={[styles.keyWarningButton, { borderColor: colors.destructive }]}
        >
          <Text style={[styles.keyWarningButtonText, { color: colors.destructive }]}>
            {retryingRoomKey
              ? "Retrying…"
              : isLoadFailure
                ? "Retry reading key"
                : "Retry saving key"}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!roomReady && deviceKeyStatus === "superseded") {
    return (
      <View
        testID="room-key-superseded"
        accessibilityRole="alert"
        style={[
          styles.blockedRoot,
          {
            backgroundColor: colors.background,
            paddingTop: headerTop + 24,
            paddingBottom: Math.max(insets.bottom, 24),
          },
        ]}
      >
        <Feather name="shield-off" size={40} color={colors.destructive} />
        <Text
          accessibilityRole="header"
          style={[styles.blockedTitle, { color: colors.foreground }]}
        >
          Encryption key replaced
        </Text>
        <Text style={[styles.blockedDescription, { color: colors.mutedForeground }]}>
          Another device or session registered a different encryption key for
          your account, so new room keys no longer reach this device. Reset the
          device encryption key in your profile to use encrypted rooms here.
        </Text>
        <TouchableOpacity
          testID="room-key-superseded-profile"
          accessibilityRole="button"
          accessibilityLabel="Open profile to reset the device encryption key"
          onPress={() => router.replace("/(tabs)/profile" as never)}
          style={[styles.blockedButton, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.blockedButtonText}>Open profile</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!roomReady) {
    return (
      <View
        testID="room-loading"
        accessibilityRole="progressbar"
        style={[
          styles.blockedRoot,
          {
            backgroundColor: colors.background,
            paddingTop: headerTop + 24,
            paddingBottom: Math.max(insets.bottom, 24),
          },
        ]}
      >
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={[styles.loadingTitle, { color: colors.foreground }]}>
          Opening room…
        </Text>
        <Text style={[styles.blockedDescription, { color: colors.mutedForeground }]}>
          {isDeviceKeyRegistrationSlow
            ? "Still registering your device key. Check your connection; encrypted rooms stay closed until it completes."
            : "Connecting securely to the conversation."}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      testID="room-keyboard-avoiding-view"
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <View
        style={[
          styles.header,
          {
            paddingTop: headerTop + 10,
            backgroundColor: colors.card,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <TouchableOpacity
          testID="room-back-button"
          onPress={() => router.replace("/(tabs)" as never)}
          hitSlop={12}
          accessibilityLabel="Return to room list"
          accessibilityRole="button"
        >
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.roomName, { color: colors.foreground }]}>
            {roomName}
          </Text>
          <Text
            testID="room-participant-count"
            accessibilityLabel={`${users.length} ${users.length === 1 ? "person" : "people"} in room`}
            style={[styles.userCount, { color: colors.mutedForeground }]}
          >
            {users.length} {users.length === 1 ? "person" : "people"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            testID="room-users-button"
            style={[styles.iconBtn, { backgroundColor: colors.secondary }]}
            onPress={() => setShowUsers((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Show room members"
          >
            <Feather name="users" size={18} color={showUsers ? colors.primary : colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="room-sandbox-button"
            disabled={!!roomKeyPersistenceFailure || !hasRoomKey}
            style={[
              styles.iconBtn,
              {
                backgroundColor: colors.secondary,
                opacity: roomKeyPersistenceFailure || !hasRoomKey ? 0.45 : 1,
              },
            ]}
            onPress={openSandbox}
            hitSlop={8}
          >
            <Feather name="code" size={18} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="room-call-button"
            disabled={!!roomKeyPersistenceFailure}
            style={[
              styles.iconBtn,
              {
                backgroundColor: colors.primary,
                opacity: roomKeyPersistenceFailure ? 0.45 : 1,
              },
            ]}
            onPress={openCall}
            hitSlop={8}
          >
            <Feather name="video" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {showUsers && (
        <ScrollView
          testID="room-member-list"
          style={[
            styles.userPanel,
            { backgroundColor: colors.card, borderBottomColor: colors.border },
          ]}
          contentContainerStyle={styles.userPanelContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          <Text style={[styles.userPanelTitle, { color: colors.mutedForeground }]}>
            ONLINE
          </Text>
          {canModerate ? (
            <Text style={[styles.moderatorLabel, { color: colors.primary }]}>
              Room moderator controls
            </Text>
          ) : null}
          {users.map((u) => (
            <View key={u.userId} style={styles.userRow}>
              <View style={[styles.userAvatar, { backgroundColor: colors.secondary }]}>
                <Text style={styles.userAvatarText}>
                  {u.avatarEmoji || u.username.charAt(0).toUpperCase()}
                </Text>
              </View>
              <Text style={[styles.userName, { color: colors.foreground }]}>
                {u.username}
                {u.userId === userId ? " (you)" : ""}
              </Text>
              {canModerate && u.userId !== userId ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Ban ${u.username} from this room`}
                  disabled={moderatingUserId !== null}
                  onPress={() => confirmBanUser(u)}
                  style={[
                    styles.banButton,
                    {
                      backgroundColor: `${colors.destructive}20`,
                      borderColor: colors.destructive,
                    },
                  ]}
                >
                  <Text style={[styles.banButtonText, { color: colors.destructive }]}>
                    {moderatingUserId === u.userId ? "Banning…" : "Ban"}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}

      {!hasRoomKey ? (
        <View
          testID="room-key-waiting"
          accessibilityRole="alert"
          style={[
            styles.keyWarning,
            { backgroundColor: colors.card, borderBottomColor: colors.border },
          ]}
        >
          <Feather name="key" size={18} color={colors.mutedForeground} />
          <View style={styles.keyWarningCopy}>
            <Text style={[styles.keyWarningTitle, { color: colors.foreground }]}>
              Waiting for this room's encryption key
            </Text>
            <Text style={[styles.keyWarningText, { color: colors.mutedForeground }]}>
              {canModerate
                ? "You created this room, so only another signed-in device or session of yours that still holds the key can hand it to this device key; it does so while it has this room open. Messages stay locked until it arrives."
                : "The room creator's device sends it to your current device key while they are online. Messages stay locked until it arrives."}
            </Text>
          </View>
        </View>
      ) : null}

      {messageReplayGap ? (
        <View
          testID="room-message-gap-warning"
          accessibilityRole="alert"
          style={[
            styles.keyWarning,
            { backgroundColor: colors.card, borderBottomColor: colors.destructive },
          ]}
        >
          <Feather name="alert-triangle" size={18} color={colors.destructive} />
          <View style={styles.keyWarningCopy}>
            <Text style={[styles.keyWarningTitle, { color: colors.foreground }]}>
              Some messages could not be recovered
            </Text>
            <Text style={[styles.keyWarningText, { color: colors.mutedForeground }]}>
              This device was disconnected longer than the room history kept for
              reconnects. Newer messages are shown below.
            </Text>
          </View>
          <TouchableOpacity
            testID="room-message-gap-dismiss"
            accessibilityRole="button"
            accessibilityLabel="Dismiss reconnect history warning"
            onPress={() => setMessageReplayGap(false)}
            style={[styles.keyWarningButton, { borderColor: colors.destructive }]}
          >
            <Text style={[styles.keyWarningButtonText, { color: colors.destructive }]}>
              Dismiss
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        testID="room-message-list"
        accessibilityLabel={`${messages.length} messages`}
        data={[...messages].reverse()}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            isSelf={item.userId === userId}
            onLongPress={canModerate && item.type === "text" ? confirmDeleteMessage : undefined}
          />
        )}
        inverted
        contentContainerStyle={[
          styles.list,
          { paddingBottom: 12 },
        ]}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!!messages.length}
      />

      <View
        style={[
          styles.inputBar,
          {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            paddingBottom: Math.max(insets.bottom, Platform.OS === "web" ? 34 : 8) + 8,
          },
        ]}
      >
          <ScaledTextInput
          ref={inputRef}
          testID="room-composer-input"
          style={[
            styles.input,
            {
              backgroundColor: colors.background,
              color: colors.foreground,
              borderColor: colors.border,
              borderRadius: colors.radius * 2,
            },
          ]}
          placeholder="Message…"
          placeholderTextColor={colors.mutedForeground}
          value={text}
          onChangeText={setText}
          multiline
          maxLength={2000}
          returnKeyType="default"
          editable={!roomKeyPersistenceFailure && hasRoomKey}
        />
        <TouchableOpacity
          testID="room-send-button"
          style={[
            styles.sendBtn,
            {
              backgroundColor:
                text.trim() && !roomKeyPersistenceFailure && hasRoomKey
                  ? colors.primary
                  : colors.muted,
              borderRadius: 22,
            },
          ]}
          onPress={sendMessage}
          activeOpacity={0.8}
          disabled={!text.trim() || !!roomKeyPersistenceFailure || !hasRoomKey}
        >
          <Feather
            name="send"
            size={18}
            color={
              text.trim() && !roomKeyPersistenceFailure && hasRoomKey
                ? "#fff"
                : colors.mutedForeground
            }
          />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  blockedRoot: {
    flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32,
  },
  blockedTitle: {
    fontSize: 24, fontWeight: "700" as const, marginTop: 18, textAlign: "center",
  },
  blockedDescription: {
    fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 420, textAlign: "center",
  },
  loadingTitle: {
    fontSize: 24, fontWeight: "700" as const, marginTop: 18, textAlign: "center",
  },
  blockedButton: {
    borderRadius: 12, marginTop: 28, paddingHorizontal: 20, paddingVertical: 13,
  },
  blockedButtonText: { color: "#fff", fontSize: 15, fontWeight: "700" as const },
  header: {
    flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 16,
    paddingBottom: 12, borderBottomWidth: 1, gap: 12,
  },
  headerCenter: { flex: 1 },
  roomName: { fontSize: 17, fontWeight: "700" as const },
  userCount: { fontSize: 12, marginTop: 1 },
  headerActions: { flexDirection: "row", gap: 8 },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
  },
  userPanel: { borderBottomWidth: 1, maxHeight: 240 },
  userPanelContent: { paddingHorizontal: 20, paddingVertical: 12, gap: 6 },
  keyWarning: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  keyWarningCopy: { flex: 1 },
  keyWarningTitle: { fontSize: 14, fontWeight: "700" as const },
  keyWarningText: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  keyWarningButton: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  keyWarningButtonText: { fontSize: 13, fontWeight: "700" as const },
  userPanelTitle: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.8, marginBottom: 4 },
  moderatorLabel: { fontSize: 12, fontWeight: "600" as const, marginBottom: 8 },
  userRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  userAvatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  userAvatarText: { fontSize: 15 },
  userName: { fontSize: 14, flex: 1, minWidth: 0 },
  banButton: {
    borderRadius: 8,
    borderWidth: 1,
    marginLeft: "auto",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  banButtonText: { fontSize: 12, fontWeight: "700" as const },
  list: { paddingTop: 8 },
  inputBar: {
    flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 14,
    paddingTop: 10, borderTopWidth: 1, gap: 10,
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: 16,
    paddingVertical: 12, fontSize: 15, borderWidth: 1,
    // Android centers multiline text vertically by default; iOS top-aligns.
    textAlignVertical: "top",
  },
  sendBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
