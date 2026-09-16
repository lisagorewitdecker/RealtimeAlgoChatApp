/**
 * AiPanel — streaming AI coding assistant panel inside a chat room.
 * Uses Claude via the /api/ai/code-assist SSE endpoint.
 */
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useColors } from "@/hooks/useColors";
import { useAccessibility } from "@/contexts/AccessibilityContext";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput as TextInput } from "@/components/ScaledTextInput";
import { textLengthBucket, trackEvent } from "@/utils/analytics";

interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
}

interface Props {
  roomId: string;
}

const BASE = process.env["EXPO_PUBLIC_DOMAIN"]
  ? `https://${process.env["EXPO_PUBLIC_DOMAIN"]}`
  : "http://localhost:5000";

export default function AiPanel({ roomId: _roomId }: Props) {
  void _roomId;
  const colors = useColors();
  const { reduceMotion } = useAccessibility();
  const { getToken } = useAuth();

  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<AiMessage>>(null);

  const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || loading) return;
    const startedAt = Date.now();

    const userMsg: AiMessage = { id: makeId(), role: "user", content };
    const assistantId = makeId();
    const assistantPlaceholder: AiMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      pending: true,
    };

    const history = [...messages, userMsg];
    setMessages([...history, assistantPlaceholder]);
    setInput("");
    setLoading(true);

    try {
      const token = await getToken();
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`${BASE}/api/ai/code-assist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as {
              content?: string;
              done?: boolean;
              error?: string;
            };
            if (data.error) throw new Error(data.error);
            if (data.content) {
              accumulated += data.content;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: accumulated, pending: false }
                    : m,
                ),
              );
            }
            if (data.done) break;
          } catch (parseErr) {
            // ignore malformed SSE line
          }
        }
      }
      trackEvent("ai_request_completed", {
        duration_ms: Date.now() - startedAt,
        prompt_length_bucket: textLengthBucket(content),
        response_length_bucket: textLengthBucket(accumulated),
      });
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") {
        trackEvent("ai_request_cancelled", {
          duration_ms: Date.now() - startedAt,
          prompt_length_bucket: textLengthBucket(content),
        });
        return;
      }
      trackEvent("ai_request_failed", {
        duration_ms: Date.now() - startedAt,
        failure_type:
          err instanceof Error && err.message.startsWith("Request failed")
            ? "http"
            : "network_or_stream",
        prompt_length_bucket: textLengthBucket(content),
      });
      const errorText =
        err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${errorText}`, pending: false }
            : m,
        ),
      );
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [input, loading, messages, getToken]);

  const clearConversation = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setLoading(false);
  }, []);

  const renderItem = ({ item }: { item: AiMessage }) => {
    const isUser = item.role === "user";
    return (
      <View
        style={[
          styles.msgRow,
          isUser ? styles.msgRowUser : styles.msgRowAssistant,
        ]}
        accessible
        accessibilityRole="text"
        accessibilityLabel={`${isUser ? "You" : "AI assistant"}: ${item.content}`}
      >
        {!isUser && (
          <View
            style={[styles.aiBadge, { backgroundColor: colors.primary + "20" }]}
            accessibilityElementsHidden
          >
            <Text style={{ fontSize: 11, color: colors.primary }}>AI</Text>
          </View>
        )}
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: isUser ? colors.bubbleSelf : colors.card,
              borderRadius: 14,
              borderWidth: isUser ? 0 : 1,
              borderColor: colors.border,
              maxWidth: "88%",
            },
          ]}
        >
          {item.pending ? (
            <View style={styles.pendingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.pendingText, { color: colors.mutedForeground, fontSize: 13 }]}>
                Thinking…
              </Text>
            </View>
          ) : (
            <Text
              style={[
                styles.msgText,
                {
                  color: isUser ? colors.bubbleSelfText : colors.foreground,
                  fontSize: 14,
                  lineHeight: 14 * 1.6,
                },
              ]}
              selectable
            >
              {item.content}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      testID="ai-panel-keyboard-avoiding-view"
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View
        style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}
        accessible
        accessibilityRole="header"
      >
        <View style={styles.headerLeft}>
          <View style={[styles.aiDot, { backgroundColor: colors.primary }]} accessibilityElementsHidden />
          <Text style={[styles.headerTitle, { color: colors.foreground, fontSize: 14 }]}>
            AI Coding Assistant
          </Text>
        </View>
        {messages.length > 0 && (
          <TouchableOpacity
            onPress={clearConversation}
            hitSlop={10}
            accessibilityLabel="Clear conversation"
            accessibilityRole="button"
          >
            <Feather name="trash-2" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>

      {/* Empty state */}
      {messages.length === 0 && (
        <View style={styles.emptyState} accessible accessibilityLiveRegion="polite">
          <Feather name="cpu" size={36} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground, fontSize: 16 }]}>
            Ask anything about code
          </Text>
          <Text style={[styles.emptyHint, { color: colors.mutedForeground, fontSize: 13 }]}>
            Debug an error, explain a concept, or get a code review
          </Text>
        </View>
      )}

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        onContentSizeChange={() =>
          listRef.current?.scrollToEnd({ animated: !reduceMotion })
        }
        accessibilityLabel="AI conversation"
      />

      {/* Input */}
      <View
        style={[
          styles.inputBar,
          {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
          },
        ]}
      >
        <TextInput
          testID="ai-panel-input"
          style={[
            styles.input,
            {
              backgroundColor: colors.background,
              color: colors.foreground,
              borderColor: colors.border,
              fontSize: 14,
            },
          ]}
          placeholder="Ask a coding question…"
          placeholderTextColor={colors.mutedForeground}
          value={input}
          onChangeText={setInput}
          multiline
          maxLength={4000}
          returnKeyType="default"
          editable={!loading}
          accessibilityLabel="Ask AI a coding question"
          accessibilityRole="none"
          accessibilityHint="Type your question and press send"
        />
        <TouchableOpacity
          style={[
            styles.sendBtn,
            {
              backgroundColor:
                input.trim() && !loading ? colors.primary : colors.muted,
              borderRadius: 22,
            },
          ]}
          onPress={send}
          disabled={!input.trim() || loading}
          accessibilityLabel="Send question to AI"
          accessibilityRole="button"
          accessibilityState={{ disabled: !input.trim() || loading }}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Feather
              name="send"
              size={18}
              color={input.trim() ? "#fff" : colors.mutedForeground}
            />
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  aiDot: { width: 8, height: 8, borderRadius: 4 },
  headerTitle: { fontWeight: "700" },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontWeight: "700", textAlign: "center" },
  emptyHint: { textAlign: "center", lineHeight: 20 },
  list: { padding: 12, gap: 8, flexGrow: 1 },
  msgRow: { flexDirection: "row", marginVertical: 4 },
  msgRowUser: { justifyContent: "flex-end" },
  msgRowAssistant: { justifyContent: "flex-start", gap: 8, alignItems: "flex-start" },
  aiBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  bubble: { paddingHorizontal: 14, paddingVertical: 10 },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pendingText: { fontStyle: "italic" },
  msgText: {},
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 8 : 12,
    borderTopWidth: 1,
    gap: 10,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 22,
    // Android centers multiline text vertically by default; iOS top-aligns.
    textAlignVertical: "top",
  },
  sendBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
