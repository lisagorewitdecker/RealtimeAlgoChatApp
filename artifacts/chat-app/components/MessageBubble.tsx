import React from "react";
import {
  StyleSheet,
  TouchableOpacity,
  View,
  Platform,
} from "react-native";
import { useColors } from "@/hooks/useColors";
import { ScaledText as Text } from "@/components/ScaledText";

interface Message {
  id: string;
  content: string;
  userId: string;
  username: string;
  avatarEmoji?: string;
  timestamp: number;
  type: "text" | "system";
  deleted?: boolean;
}

interface Props {
  message: Message;
  isSelf: boolean;
  /** Called when moderator long-presses a message bubble. */
  onLongPress?: (messageId: string) => void;
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({ message, isSelf, onLongPress }: Props) {
  const colors = useColors();

  if (message.type === "system") {
    return (
      <View style={styles.systemRow} accessible accessibilityRole="text" accessibilityLabel={message.content}>
        <Text style={[styles.systemText, { color: colors.systemMsg, fontSize: 12 }]}>
          {message.content}
        </Text>
      </View>
    );
  }

  const isDeleted = message.deleted;

  const bubbleContent = (
    <View
      style={[
        styles.bubble,
        {
          backgroundColor: isSelf
            ? colors.bubbleSelf
            : colors.bubbleOther,
          borderRadius: colors.radius,
          borderBottomRightRadius: isSelf ? 4 : colors.radius,
          borderBottomLeftRadius: isSelf ? colors.radius : 4,
          opacity: isDeleted ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.text,
          {
            color: isSelf ? colors.bubbleSelfText : colors.bubbleOtherText,
            fontSize: 15,
            lineHeight: 15 * 1.4,
            fontStyle: isDeleted ? "italic" : "normal",
          },
        ]}
        selectable={!isDeleted}
      >
        {isDeleted ? "Message deleted" : message.content}
      </Text>
    </View>
  );

  return (
    <View
      style={[styles.row, isSelf ? styles.rowSelf : styles.rowOther]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={
        isDeleted
          ? `${message.username}: message deleted`
          : `${isSelf ? "You" : message.username}: ${message.content}, ${formatTime(message.timestamp)}`
      }
    >
      {!isSelf && (
        <View
          style={[
            styles.avatar,
            { backgroundColor: stringToColor(message.username) },
          ]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          <Text style={styles.avatarText}>
            {message.avatarEmoji || message.username.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.bubbleCol}>
        {!isSelf && (
          <Text
            style={[styles.username, { color: colors.mutedForeground, fontSize: 11 }]}
            accessibilityElementsHidden
          >
            {message.username}
          </Text>
        )}
        {onLongPress && !isDeleted ? (
          <TouchableOpacity
            onLongPress={() => onLongPress(message.id)}
            delayLongPress={400}
            activeOpacity={0.85}
            accessibilityLabel={`${isSelf ? "You" : message.username}: ${message.content}. Long press for moderation options.`}
            accessibilityHint="Long press to open moderation menu"
            accessibilityRole="button"
          >
            {bubbleContent}
          </TouchableOpacity>
        ) : (
          bubbleContent
        )}
        <Text
          style={[styles.time, { color: colors.mutedForeground, fontSize: 10 }]}
          accessibilityElementsHidden
        >
          {formatTime(message.timestamp)}
        </Text>
      </View>
    </View>
  );
}

function stringToColor(str: string) {
  const hues = [210, 145, 280, 340, 30, 180, 60];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${hues[Math.abs(hash) % hues.length]}, 65%, 48%)`;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", marginVertical: 4, paddingHorizontal: 16 },
  rowSelf: { justifyContent: "flex-end" },
  rowOther: { justifyContent: "flex-start" },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
    marginRight: 8, alignSelf: "flex-end",
  },
  avatarText: { color: "#fff", fontSize: 13, fontWeight: "700" as const },
  bubbleCol: { maxWidth: "75%" },
  username: { marginBottom: 3, marginLeft: 2 },
  bubble: { paddingHorizontal: 14, paddingVertical: 10 },
  text: {},
  time: { marginTop: 3, alignSelf: "flex-end" },
  systemRow: { alignItems: "center", marginVertical: 8 },
  systemText: { fontStyle: "italic" },
});
