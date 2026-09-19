import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import * as Haptics from "expo-haptics";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AVATAR_EMOJIS, type AvatarEmoji } from "@/constants/avatarEmojis";
import { PRODUCT_NAME } from "@/constants/branding";
import { useApp } from "@/contexts/AppContext";
import { useAccessibility } from "@/contexts/AccessibilityContext";
import { useSocket } from "@/contexts/SocketContext";
import { DeviceEncryptionCard } from "@/components/DeviceEncryptionCard";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput as TextInput } from "@/components/ScaledTextInput";
import { useColors } from "@/hooks/useColors";
import { useTabBarContentInset } from "@/hooks/useTabBarContentInset";
import { getBuildIdentity } from "@/lib/buildIdentity";
import { trackEvent } from "@/utils/analytics";

type ModerationFeedback = {
  kind: "success" | "error";
  message: string;
};

type AccountSearchResult = {
  userId: string;
  username: string;
  avatarEmoji: string;
  email: string | null;
  banned: boolean;
};

type ModerationHistoryEntry = {
  id: number;
  action: "ban" | "restore" | "message_delete";
  actorUserId: string;
  actorUsername: string;
  targetUserId: string | null;
  targetUsername: string | null;
  targetEmail: string | null;
  roomId: string | null;
  messageId: string | null;
  createdAt: string;
};

function apiBaseUrl(): string {
  const domain = process.env["EXPO_PUBLIC_DOMAIN"];
  return domain ? `https://${domain}` : "http://localhost:5000";
}

export default function ProfileScreen() {
  const buildIdentity = getBuildIdentity();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  // The tab bar overlays this screen (whatever scrolls under it is covered or
  // dimmed and out of reach), so the end of the scroll content must
  // clear its full height, not just the inset.
  const bottomContentInset = useTabBarContentInset(24);
  const { username, avatarEmoji, userId, isAdmin, setUsername, setAvatarEmoji } = useApp();
  const {
    highContrast,
    fontScale,
    reduceMotion,
    reduceTransparency,
    setHighContrast,
    setFontScale,
    setReduceMotion,
    setReduceTransparency,
  } = useAccessibility();
  const { getToken } = useAuth();
  const { isConnected, connectionError } = useSocket();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(username);
  const [saved, setSaved] = useState(false);
  const [moderationUserId, setModerationUserId] = useState("");
  const [moderationFeedback, setModerationFeedback] =
    useState<ModerationFeedback | null>(null);
  const [isModerating, setIsModerating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AccountSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<AccountSearchResult | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ModerationHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [historyNextCursor, setHistoryNextCursor] = useState<number | null>(null);
  const [historyTargetFilter, setHistoryTargetFilter] = useState("");
  const [historyActorFilter, setHistoryActorFilter] = useState("");
  const [appliedHistoryFilters, setAppliedHistoryFilters] = useState<{
    targetUserId?: string;
    actorUserId?: string;
  }>({});
  // Tracks the most recently started history request. Any older,
  // still-in-flight request's response is discarded on arrival so that a
  // slow initial/filtered/load-more request can never clobber the result of
  // a request the admin triggered afterward (e.g. changing filters while a
  // "Load more" fetch is still pending).
  const historyRequestIdRef = useRef(0);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  async function handleSave() {
    const trimmed = draft.trim();
    if (trimmed.length < 2) {
      Alert.alert("Name too short", "Please enter at least 2 characters.");
      return;
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await setUsername(trimmed);
    setEditing(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleEmojiSelect(emoji: AvatarEmoji) {
    if (emoji === avatarEmoji) return;
    await Haptics.selectionAsync();
    await setAvatarEmoji(emoji);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleSearch() {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchError("Enter at least 2 characters to search.");
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    setSearchError(null);
    try {
      const token = await getToken();
      const base = apiBaseUrl();
      const response = await fetch(
        `${base}/api/moderation/search?query=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${token ?? ""}` } },
      );
      const result = (await response.json().catch(() => null)) as {
        results?: AccountSearchResult[];
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(result?.error ?? "Unable to search accounts.");
      }
      setSearchResults(result?.results ?? []);
    } catch (error) {
      setSearchResults([]);
      setSearchError(
        error instanceof Error ? error.message : "Unable to search accounts.",
      );
    } finally {
      setIsSearching(false);
    }
  }

  async function fetchHistory(options?: {
    cursor?: number;
    append?: boolean;
    targetUserId?: string;
    actorUserId?: string;
  }) {
    const append = options?.append ?? false;
    const requestId = ++historyRequestIdRef.current;
    if (append) {
      setIsLoadingMoreHistory(true);
    } else {
      setIsLoadingHistory(true);
      // A fresh (non-append) request supersedes any in-flight "load more"
      // request. That older request's own `finally` will see its request id
      // is stale and skip cleanup, so clear its loading state here --
      // otherwise the Load more button could stay stuck disabled forever.
      setIsLoadingMoreHistory(false);
    }
    setHistoryError(null);
    try {
      const token = await getToken();
      const base = apiBaseUrl();
      // Callers must pass the complete desired filter set explicitly (including
      // `undefined` to mean "no filter") -- merging with `appliedHistoryFilters`
      // state here would read a stale closure when a caller updates that state
      // and calls fetchHistory in the same synchronous handler (e.g. Clear).
      const targetUserId = options?.targetUserId;
      const actorUserId = options?.actorUserId;
      const params = new URLSearchParams();
      if (options?.cursor !== undefined) params.set("cursor", String(options.cursor));
      if (targetUserId) params.set("targetUserId", targetUserId);
      if (actorUserId) params.set("actorUserId", actorUserId);
      const queryString = params.toString();
      const response = await fetch(
        `${base}/api/moderation/history${queryString ? `?${queryString}` : ""}`,
        { headers: { Authorization: `Bearer ${token ?? ""}` } },
      );
      const result = (await response.json().catch(() => null)) as {
        actions?: ModerationHistoryEntry[];
        nextCursor?: number | null;
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(result?.error ?? "Unable to load moderation history.");
      }
      // A newer request (fresh reload, filter change, or another load-more)
      // has since started -- this response is stale, so drop it instead of
      // mixing results from two different query sets.
      if (historyRequestIdRef.current !== requestId) return;
      setHistoryEntries((current) =>
        append ? [...current, ...(result?.actions ?? [])] : result?.actions ?? [],
      );
      setHistoryNextCursor(result?.nextCursor ?? null);
    } catch (error) {
      if (historyRequestIdRef.current !== requestId) return;
      setHistoryError(
        error instanceof Error ? error.message : "Unable to load moderation history.",
      );
    } finally {
      if (historyRequestIdRef.current === requestId) {
        if (append) {
          setIsLoadingMoreHistory(false);
        } else {
          setIsLoadingHistory(false);
        }
      }
    }
  }

  function handleApplyHistoryFilters() {
    const targetUserId = historyTargetFilter.trim() || undefined;
    const actorUserId = historyActorFilter.trim() || undefined;
    setAppliedHistoryFilters({ targetUserId, actorUserId });
    void fetchHistory({ targetUserId, actorUserId });
  }

  // One-tap filtering from a search result, the selected account, or a
  // history row: fills in the matching filter field and re-runs the query
  // immediately, without disturbing whatever is currently in the other field.
  function filterHistoryByTarget(userId: string) {
    setHistoryTargetFilter(userId);
    const actorUserId = historyActorFilter.trim() || undefined;
    setAppliedHistoryFilters({ targetUserId: userId, actorUserId });
    void fetchHistory({ targetUserId: userId, actorUserId });
  }

  function filterHistoryByActor(userId: string) {
    setHistoryActorFilter(userId);
    const targetUserId = historyTargetFilter.trim() || undefined;
    setAppliedHistoryFilters({ targetUserId, actorUserId: userId });
    void fetchHistory({ targetUserId, actorUserId: userId });
  }

  function handleClearHistoryFilters() {
    setHistoryTargetFilter("");
    setHistoryActorFilter("");
    setAppliedHistoryFilters({});
    void fetchHistory({});
  }

  function handleLoadMoreHistory() {
    if (historyNextCursor === null) return;
    void fetchHistory({
      cursor: historyNextCursor,
      append: true,
      targetUserId: appliedHistoryFilters.targetUserId,
      actorUserId: appliedHistoryFilters.actorUserId,
    });
  }

  // Only re-fetch when admin status changes -- `getToken` from Clerk is not
  // guaranteed to be referentially stable across renders, so depending on it
  // here would cause a fetch loop instead of a one-time load.
  useEffect(() => {
    if (isAdmin) void fetchHistory();
  }, [isAdmin]);

  function handleSelectAccount(account: AccountSearchResult) {
    setSelectedAccount(account);
    setModerationUserId(account.userId);
    setModerationFeedback(null);
  }

  function handleModerationUserIdChange(value: string) {
    setModerationUserId(value);
    if (selectedAccount && value !== selectedAccount.userId) {
      setSelectedAccount(null);
    }
  }

  async function setBanState(banned: boolean) {
    const targetId = moderationUserId.trim();
    if (!targetId) {
      setModerationFeedback({
        kind: "error",
        message: "Enter an account user ID before changing access.",
      });
      return;
    }

    setIsModerating(true);
    setModerationFeedback(null);
    try {
      const token = await getToken();
      const base = apiBaseUrl();
      const response = await fetch(
        banned
          ? `${base}/api/moderation/ban`
          : `${base}/api/moderation/ban/${encodeURIComponent(targetId)}`,
        {
          method: banned ? "POST" : "DELETE",
          headers: {
            Authorization: `Bearer ${token ?? ""}`,
            ...(banned ? { "Content-Type": "application/json" } : {}),
          },
          ...(banned ? { body: JSON.stringify({ userId: targetId }) } : {}),
        },
      );
      const result = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(result?.error ?? "Unable to update this account.");
      }
      const label =
        selectedAccount && selectedAccount.userId === targetId
          ? `${selectedAccount.username} (${targetId})`
          : targetId;
      setModerationFeedback({
        kind: "success",
        message: banned
          ? `Account ${label} is banned and can no longer access ${PRODUCT_NAME}.`
          : `Account ${label} has been restored and can access ${PRODUCT_NAME} again.`,
      });
      setSearchResults((results) =>
        results.map((result) =>
          result.userId === targetId ? { ...result, banned } : result,
        ),
      );
      setSelectedAccount((current) =>
        current && current.userId === targetId ? { ...current, banned } : current,
      );
      void fetchHistory({
        targetUserId: appliedHistoryFilters.targetUserId,
        actorUserId: appliedHistoryFilters.actorUserId,
      });
    } catch (error) {
      setModerationFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to update this account.",
      });
    } finally {
      setIsModerating(false);
    }
  }

  return (
    <KeyboardAvoidingView
      testID="profile-keyboard-avoiding-view"
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <View
        style={[
          styles.header,
          { paddingTop: topPad + 14, backgroundColor: colors.background, borderBottomColor: colors.border },
        ]}
      >
        <Text style={[styles.title, { color: colors.foreground }]}>Profile</Text>
        <View
          style={[
            styles.statusBadge,
            { backgroundColor: isConnected ? `${colors.online}20` : `${colors.mutedForeground}20` },
          ]}
        >
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isConnected ? colors.online : colors.mutedForeground },
            ]}
          />
          <Text
            style={[
              styles.statusText,
              { color: isConnected ? colors.online : colors.mutedForeground },
            ]}
          >
            {isConnected ? "Connected" : "Offline"}
          </Text>
        </View>
        {connectionError ? (
          <Text accessibilityRole="alert" style={[styles.connectionError, { color: colors.destructive }]}>
            {connectionError}
          </Text>
        ) : null}
      </View>

      <ScrollView
        testID="profile-scroll"
        style={styles.content}
        contentContainerStyle={{ paddingBottom: bottomContentInset }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View
          style={[
            styles.avatarRing,
            { backgroundColor: colors.primary + "20", borderRadius: 60 },
          ]}
        >
          <Text style={styles.avatarEmoji}>{avatarEmoji}</Text>
        </View>

        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            PROFILE EMOJI
          </Text>
          <Text style={[styles.emojiHint, { color: colors.mutedForeground }]}>
            Choose the avatar your teammates will see in chat.
          </Text>
          <View style={styles.emojiGrid}>
            {AVATAR_EMOJIS.map((emoji) => {
              const selected = emoji === avatarEmoji;
              return (
                <TouchableOpacity
                  key={emoji}
                  style={[
                    styles.emojiOption,
                    {
                      backgroundColor: selected ? colors.primary + "20" : colors.background,
                      borderColor: selected ? colors.primary : colors.border,
                      borderRadius: colors.radius - 2,
                    },
                  ]}
                  onPress={() => handleEmojiSelect(emoji)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`Choose ${emoji} as your profile emoji`}
                  accessibilityState={{ selected }}
                  testID={`avatar-emoji-${emoji}`}
                >
                  <Text style={styles.emojiOptionText}>{emoji}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            DISPLAY NAME
          </Text>
          {editing ? (
            <View style={styles.editRow}>
              <TextInput
                testID="profile-display-name-input"
                style={[
                  styles.input,
                  {
                    color: colors.foreground,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                    borderRadius: colors.radius - 2,
                  },
                ]}
                value={draft}
                onChangeText={setDraft}
                autoFocus
                maxLength={30}
                returnKeyType="done"
                onSubmitEditing={handleSave}
                placeholderTextColor={colors.mutedForeground}
              />
              <TouchableOpacity
                testID="profile-save-name-button"
                accessibilityRole="button"
                accessibilityLabel="Save display name"
                style={[styles.saveBtn, { backgroundColor: colors.primary, borderRadius: colors.radius - 2 }]}
                onPress={handleSave}
                activeOpacity={0.8}
              >
                <Feather name="check" size={18} color={colors.primaryForeground} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              testID="profile-edit-name-button"
              accessibilityRole="button"
              accessibilityLabel="Edit display name"
              style={styles.nameRow}
              onPress={() => { setDraft(username); setEditing(true); }}
              activeOpacity={0.7}
            >
              <Text style={[styles.name, { color: colors.foreground }]}>{username || "Tap to set name"}</Text>
              <Feather name="edit-2" size={16} color={colors.primary} />
            </TouchableOpacity>
          )}
          {saved && (
            <Text style={[styles.saved, { color: colors.online }]}>Saved!</Text>
          )}
        </View>

        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>USER ID</Text>
          <Text style={[styles.uid, { color: colors.mutedForeground }]} numberOfLines={1}>
            {userId}
          </Text>
        </View>

        <View
          testID="build-identity"
          accessible
          accessibilityLabel={`Build information. App version ${buildIdentity.appVersion}. Build ID ${buildIdentity.buildId}. Update created ${buildIdentity.createdAt}. Runtime ${buildIdentity.runtimeVersion}. Client ${buildIdentity.clientType}.`}
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <View style={styles.buildIdentityHeading}>
            <Feather name="info" size={16} color={colors.primary} />
            <Text style={[styles.sectionLabel, { color: colors.primary }]}>BUILD INFORMATION</Text>
          </View>
          <View style={styles.buildIdentityRows}>
            <BuildIdentityRow label="App version" value={buildIdentity.appVersion} />
            <BuildIdentityRow label="Build ID" value={buildIdentity.buildId} />
            <BuildIdentityRow label="Update created" value={buildIdentity.createdAt} />
            <BuildIdentityRow label="Runtime" value={buildIdentity.runtimeVersion} />
            <BuildIdentityRow label="Client" value={buildIdentity.clientType} />
          </View>
        </View>

        <DeviceEncryptionCard />

        <View
          testID="accessibility-settings"
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <View style={styles.accessibilityHeading}>
            <Feather name="eye" size={16} color={colors.primary} />
            <Text style={[styles.sectionLabel, { color: colors.primary }]}>
              ACCESSIBILITY
            </Text>
          </View>
          <Text style={[styles.accessibilityHint, { color: colors.mutedForeground }]}>
            Personalize contrast, text size, motion, and transparency to make{" "}
            {PRODUCT_NAME} more comfortable to use.
          </Text>

          <View style={styles.accessibilityOption}>
            <View style={styles.accessibilityOptionCopy}>
              <Text style={[styles.accessibilityOptionTitle, { color: colors.foreground }]}>
                High contrast
              </Text>
              <Text style={[styles.accessibilityOptionHint, { color: colors.mutedForeground }]}>
                Use stronger contrast throughout the app.
              </Text>
            </View>
            <TouchableOpacity
              testID="accessibility-high-contrast-toggle"
              style={[
                styles.accessibilityToggle,
                {
                  backgroundColor: highContrast ? colors.primary : colors.background,
                  borderColor: highContrast ? colors.primary : colors.border,
                  borderRadius: colors.radius - 2,
                },
              ]}
              onPress={() => {
                const nextValue = !highContrast;
                setHighContrast(nextValue);
                trackEvent("accessibility_preference_changed", {
                  preference: "high_contrast",
                  value: nextValue,
                });
              }}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityLabel={`High contrast: ${highContrast ? "on" : "off"}`}
              accessibilityState={{ checked: highContrast }}
            >
              <Text
                style={[
                  styles.accessibilityToggleText,
                  { color: highContrast ? colors.primaryForeground : colors.foreground },
                ]}
              >
                {highContrast ? "On" : "Off"}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.accessibilityOption}>
            <View style={styles.accessibilityOptionCopy}>
              <Text style={[styles.accessibilityOptionTitle, { color: colors.foreground }]}>
                Text size
              </Text>
              <Text style={[styles.accessibilityOptionHint, { color: colors.mutedForeground }]}>
                Current size: {Math.round(fontScale * 100)}%
              </Text>
            </View>
            <View
              style={styles.fontScaleOptions}
              accessibilityRole="radiogroup"
              accessibilityLabel="Text size"
            >
              {([1.0, 1.1, 1.2, 1.4] as const).map((scale) => {
                const selected = fontScale === scale;
                return (
                  <TouchableOpacity
                    key={scale}
                    testID={`accessibility-font-scale-${Math.round(scale * 100)}`}
                    style={[
                      styles.fontScaleOption,
                      {
                        backgroundColor: selected ? colors.primary : colors.background,
                        borderColor: selected ? colors.primary : colors.border,
                        borderRadius: colors.radius - 3,
                      },
                    ]}
                    onPress={() => {
                      if (selected) return;
                      setFontScale(scale);
                      trackEvent("accessibility_preference_changed", {
                        preference: "text_size",
                        value: `${Math.round(scale * 100)}_percent`,
                      });
                    }}
                    activeOpacity={0.8}
                    accessibilityRole="radio"
                    accessibilityLabel={`Text size ${Math.round(scale * 100)} percent`}
                    accessibilityState={{ selected }}
                  >
                    <Text
                      style={[
                        styles.fontScaleOptionText,
                        { color: selected ? colors.primaryForeground : colors.foreground },
                      ]}
                    >
                      {Math.round(scale * 100)}%
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.accessibilityOption}>
            <View style={styles.accessibilityOptionCopy}>
              <Text style={[styles.accessibilityOptionTitle, { color: colors.foreground }]}>
                Reduced motion
              </Text>
              <Text style={[styles.accessibilityOptionHint, { color: colors.mutedForeground }]}>
                Minimize animations and transitions.
              </Text>
            </View>
            <TouchableOpacity
              testID="accessibility-reduced-motion-toggle"
              style={[
                styles.accessibilityToggle,
                {
                  backgroundColor: reduceMotion ? colors.primary : colors.background,
                  borderColor: reduceMotion ? colors.primary : colors.border,
                  borderRadius: colors.radius - 2,
                },
              ]}
              onPress={() => {
                const nextValue = !reduceMotion;
                setReduceMotion(nextValue);
                trackEvent("accessibility_preference_changed", {
                  preference: "reduced_motion",
                  value: nextValue,
                });
              }}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityLabel={`Reduced motion: ${reduceMotion ? "on" : "off"}`}
              accessibilityState={{ checked: reduceMotion }}
            >
              <Text
                style={[
                  styles.accessibilityToggleText,
                  { color: reduceMotion ? colors.primaryForeground : colors.foreground },
                ]}
              >
                {reduceMotion ? "On" : "Off"}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.accessibilityOption}>
            <View style={styles.accessibilityOptionCopy}>
              <Text style={[styles.accessibilityOptionTitle, { color: colors.foreground }]}>
                Reduce transparency
              </Text>
              <Text style={[styles.accessibilityOptionHint, { color: colors.mutedForeground }]}>
                Use a solid tab bar instead of a see-through one.
              </Text>
            </View>
            <TouchableOpacity
              testID="accessibility-reduce-transparency-toggle"
              style={[
                styles.accessibilityToggle,
                {
                  backgroundColor: reduceTransparency ? colors.primary : colors.background,
                  borderColor: reduceTransparency ? colors.primary : colors.border,
                  borderRadius: colors.radius - 2,
                },
              ]}
              onPress={() => {
                const nextValue = !reduceTransparency;
                setReduceTransparency(nextValue);
                trackEvent("accessibility_preference_changed", {
                  preference: "reduce_transparency",
                  value: nextValue,
                });
              }}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityLabel={`Reduce transparency: ${reduceTransparency ? "on" : "off"}`}
              accessibilityState={{ checked: reduceTransparency }}
            >
              <Text
                style={[
                  styles.accessibilityToggleText,
                  { color: reduceTransparency ? colors.primaryForeground : colors.foreground },
                ]}
              >
                {reduceTransparency ? "On" : "Off"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {isAdmin ? (
          <View
            testID="moderation-panel"
            style={[
              styles.card,
              styles.moderationCard,
              {
                backgroundColor: colors.card,
                borderColor: colors.destructive,
                borderRadius: colors.radius,
              },
            ]}
          >
            <View style={styles.moderationHeading}>
              <Feather name="shield" size={16} color={colors.destructive} />
              <Text style={[styles.sectionLabel, { color: colors.destructive }]}>
                ACCOUNT MODERATION
              </Text>
            </View>
            <Text style={[styles.moderationHint, { color: colors.mutedForeground }]}>
              Ban immediately removes room, call, sandbox, and assistant access.
              Restore returns access to verified accounts.
            </Text>

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              FIND AN ACCOUNT
            </Text>
            <View style={styles.searchRow}>
              <TextInput
                testID="moderation-search-input"
                style={[
                  styles.input,
                  {
                    color: colors.foreground,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                    borderRadius: colors.radius - 2,
                  },
                ]}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Search by display name or email"
                placeholderTextColor={colors.mutedForeground}
                returnKeyType="search"
                onSubmitEditing={() => void handleSearch()}
              />
              <TouchableOpacity
                testID="moderation-search-button"
                style={[
                  styles.searchBtn,
                  {
                    backgroundColor: colors.primary,
                    borderRadius: colors.radius - 2,
                    opacity: isSearching ? 0.6 : 1,
                  },
                ]}
                onPress={() => void handleSearch()}
                disabled={isSearching}
                accessibilityRole="button"
                accessibilityLabel="Search accounts"
              >
                <Feather
                  name={isSearching ? "loader" : "search"}
                  size={18}
                  color={colors.primaryForeground}
                />
              </TouchableOpacity>
            </View>
            {searchError ? (
              <Text
                testID="moderation-search-error"
                accessibilityRole="alert"
                style={[styles.moderationHint, { color: colors.destructive }]}
              >
                {searchError}
              </Text>
            ) : null}
            {searchResults.length > 0 ? (
              <View
                testID="moderation-search-results"
                style={[styles.searchResults, { borderColor: colors.border }]}
              >
                {searchResults.map((result) => {
                  const selected = selectedAccount?.userId === result.userId;
                  return (
                    <TouchableOpacity
                      key={result.userId}
                      testID={`moderation-search-result-${result.userId}`}
                      style={[
                        styles.searchResultRow,
                        {
                          borderColor: colors.border,
                          backgroundColor: selected
                            ? colors.primary + "20"
                            : "transparent",
                        },
                      ]}
                      onPress={() => handleSelectAccount(result)}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel={`Select account ${result.username}`}
                    >
                      <Text style={styles.searchResultEmoji}>{result.avatarEmoji}</Text>
                      <View style={styles.searchResultInfo}>
          <Text style={[styles.searchResultName, { color: colors.foreground }]}>
                          {result.username}
                        </Text>
                        <Text
                          style={[styles.searchResultMeta, { color: colors.mutedForeground }]}
                        >
                          {result.email ?? result.userId}
                        </Text>
                      </View>
                      {result.banned ? (
                        <Text
                          style={[styles.searchResultBadge, { color: colors.destructive }]}
                        >
                          Banned
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}

            {selectedAccount ? (
              <View
                testID="moderation-selected-account"
                style={[
                  styles.selectedAccount,
                  { backgroundColor: colors.background, borderColor: colors.border, borderRadius: colors.radius - 2 },
                ]}
              >
                <Text style={styles.searchResultEmoji}>{selectedAccount.avatarEmoji}</Text>
                <View style={styles.searchResultInfo}>
                  <Text style={[styles.searchResultName, { color: colors.foreground }]}>
                    Selected: {selectedAccount.username}
                  </Text>
                  <Text style={[styles.searchResultMeta, { color: colors.mutedForeground }]}>
                    {selectedAccount.email ?? selectedAccount.userId}
                    {selectedAccount.banned ? " · Currently banned" : ""}
                  </Text>
                </View>
                <TouchableOpacity
                  testID="moderation-selected-account-filter-history"
                  style={[
                    styles.filterHistoryChip,
                    { borderColor: colors.border, borderRadius: colors.radius - 4 },
                  ]}
                  onPress={() => filterHistoryByTarget(selectedAccount.userId)}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter moderation history by ${selectedAccount.username}`}
                >
                  <Feather name="filter" size={12} color={colors.foreground} />
                  <Text style={[styles.filterHistoryChipText, { color: colors.foreground }]}>
                    Filter history
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              ACCOUNT USER ID
            </Text>
            <TextInput
              testID="moderation-user-id"
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                  borderRadius: colors.radius - 2,
                },
              ]}
              value={moderationUserId}
              onChangeText={handleModerationUserIdChange}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Account user ID"
              placeholderTextColor={colors.mutedForeground}
            />
            <View style={styles.moderationActions}>
              <TouchableOpacity
                testID="ban-account-button"
                style={[
                  styles.moderationButton,
                  {
                    backgroundColor: colors.destructive,
                    borderRadius: colors.radius - 2,
                    opacity: isModerating ? 0.6 : 1,
                  },
                ]}
                onPress={() => void setBanState(true)}
                disabled={isModerating}
                accessibilityRole="button"
                accessibilityLabel="Ban account"
              >
                <Text style={[styles.moderationButtonText, { color: colors.primaryForeground }]}>
                  {isModerating ? "Updating…" : "Ban account"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="restore-account-button"
                style={[
                  styles.moderationButton,
                  {
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                    borderWidth: 1,
                    borderRadius: colors.radius - 2,
                    opacity: isModerating ? 0.6 : 1,
                  },
                ]}
                onPress={() => void setBanState(false)}
                disabled={isModerating}
                accessibilityRole="button"
                accessibilityLabel="Restore account"
              >
                <Text style={[styles.moderationButtonText, { color: colors.foreground }]}>
                  Restore access
                </Text>
              </TouchableOpacity>
            </View>
            {moderationFeedback ? (
              <Text
                testID="moderation-feedback"
                accessibilityRole="alert"
                style={[
                  styles.moderationFeedback,
                  {
                    color:
                      moderationFeedback.kind === "success"
                        ? colors.online
                        : colors.destructive,
                  },
                ]}
              >
                {moderationFeedback.message}
              </Text>
            ) : null}

            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              MODERATION HISTORY
            </Text>
            <View style={styles.historyFilterRow}>
              <TextInput
                testID="moderation-history-target-filter"
                style={[
                  styles.input,
                  styles.historyFilterInput,
                  {
                    color: colors.foreground,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                    borderRadius: colors.radius - 2,
                  },
                ]}
                value={historyTargetFilter}
                onChangeText={setHistoryTargetFilter}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Filter by account ID"
                placeholderTextColor={colors.mutedForeground}
              />
              <TextInput
                testID="moderation-history-actor-filter"
                style={[
                  styles.input,
                  styles.historyFilterInput,
                  {
                    color: colors.foreground,
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                    borderRadius: colors.radius - 2,
                  },
                ]}
                value={historyActorFilter}
                onChangeText={setHistoryActorFilter}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Filter by admin ID"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>
            <View style={styles.historyFilterActions}>
              <TouchableOpacity
                testID="moderation-history-filter-apply"
                style={[
                  styles.historyFilterButton,
                  { backgroundColor: colors.primary, borderRadius: colors.radius - 2 },
                ]}
                onPress={handleApplyHistoryFilters}
                accessibilityRole="button"
                accessibilityLabel="Apply history filters"
              >
                <Text style={[styles.historyFilterButtonText, { color: colors.primaryForeground }]}>
                  Filter
                </Text>
              </TouchableOpacity>
              {appliedHistoryFilters.targetUserId || appliedHistoryFilters.actorUserId ? (
                <TouchableOpacity
                  testID="moderation-history-filter-clear"
                  style={[
                    styles.historyFilterButton,
                    { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1, borderRadius: colors.radius - 2 },
                  ]}
                  onPress={handleClearHistoryFilters}
                  accessibilityRole="button"
                  accessibilityLabel="Clear history filters"
                >
                  <Text style={[styles.historyFilterButtonText, { color: colors.foreground }]}>
                    Clear
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {historyError ? (
              <Text
                testID="moderation-history-error"
                accessibilityRole="alert"
                style={[styles.moderationHint, { color: colors.destructive }]}
              >
                {historyError}
              </Text>
            ) : isLoadingHistory && historyEntries.length === 0 ? (
              <Text style={[styles.moderationHint, { color: colors.mutedForeground }]}>
                Loading history…
              </Text>
            ) : historyEntries.length === 0 ? (
              <Text style={[styles.moderationHint, { color: colors.mutedForeground }]}>
                {appliedHistoryFilters.targetUserId || appliedHistoryFilters.actorUserId
                  ? "No moderation actions match these filters."
                  : "No moderation actions yet."}
              </Text>
            ) : (
              <>
                <View testID="moderation-history-list" style={styles.historyList}>
                  {historyEntries.map((entry) => (
                    <View
                      key={entry.id}
                      testID={`moderation-history-entry-${entry.id}`}
                      style={[styles.historyRow, { borderColor: colors.border }]}
                    >
                      <Text style={[styles.historyText, { color: colors.foreground }]}>
                        <Text
                          testID={`moderation-history-entry-${entry.id}-filter-actor`}
                          onPress={() => filterHistoryByActor(entry.actorUserId)}
                          accessibilityRole="button"
                          accessibilityLabel={`Filter moderation history by admin ${entry.actorUsername}`}
                          style={[styles.historyActorLink, { color: colors.primary }]}
                        >
                          {entry.actorUsername}
                        </Text>
                        {entry.action === "message_delete" ? (
                          ` deleted message ${entry.messageId ?? "unknown"} from room ${entry.roomId ?? "unknown"}`
                        ) : (
                          <>
                            {entry.action === "ban" ? " banned " : " restored "}
                            <Text
                              testID={`moderation-history-entry-${entry.id}-filter-target`}
                              onPress={() => entry.targetUserId && filterHistoryByTarget(entry.targetUserId)}
                              accessibilityRole="button"
                              accessibilityLabel={`Filter moderation history by account ${entry.targetUsername ?? "unknown"}`}
                              style={[styles.historyActorLink, { color: colors.primary }]}
                            >
                              {entry.targetUsername ?? "Unknown account"}
                            </Text>
                          </>
                        )}
                      </Text>
                      <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </Text>
                    </View>
                  ))}
                </View>
                {historyNextCursor !== null ? (
                  <TouchableOpacity
                    testID="moderation-history-load-more"
                    style={[
                      styles.historyLoadMore,
                      { borderColor: colors.border, borderRadius: colors.radius - 2, opacity: isLoadingMoreHistory ? 0.6 : 1 },
                    ]}
                    onPress={handleLoadMoreHistory}
                    disabled={isLoadingMoreHistory}
                    accessibilityRole="button"
                    accessibilityLabel="Load more moderation history"
                  >
                    <Text style={[styles.historyFilterButtonText, { color: colors.foreground }]}>
                      {isLoadingMoreHistory ? "Loading…" : "Load more"}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </>
            )}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );

  function BuildIdentityRow({ label, value }: { label: string; value: string }) {
    return (
      <View style={styles.buildIdentityRow}>
        <Text style={[styles.buildIdentityLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text
          selectable
          style={[styles.buildIdentityValue, { color: colors.foreground }]}
        >
          {value}
        </Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1,
  },
  title: { fontSize: 28, fontWeight: "800" as const },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: "600" as const },
  connectionError: { fontSize: 12, marginTop: 8, paddingHorizontal: 20 },
  content: { flex: 1, paddingHorizontal: 20, paddingTop: 32, gap: 16 },
  avatarRing: {
    width: 100, height: 100, alignItems: "center",
    justifyContent: "center", alignSelf: "center", marginBottom: 8,
  },
  avatarEmoji: { fontSize: 50, lineHeight: 60 },
  card: { padding: 16, borderWidth: 1, gap: 8 },
  sectionLabel: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.8 },
  emojiHint: { fontSize: 12, lineHeight: 18 },
  emojiGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  emojiOption: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  emojiOptionText: { fontSize: 24 },
  nameRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  name: { fontSize: 18, fontWeight: "600" as const },
  editRow: { flexDirection: "row", gap: 10 },
  input: { flex: 1, height: 44, paddingHorizontal: 12, fontSize: 16, borderWidth: 1 },
  saveBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  saved: { fontSize: 13, fontWeight: "600" as const },
  uid: { fontSize: 12, fontFamily: Platform.OS === "ios" ? "Courier" : "monospace" },
  buildIdentityHeading: { flexDirection: "row", alignItems: "center", gap: 8 },
  buildIdentityRows: { gap: 7 },
  buildIdentityRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  buildIdentityLabel: { width: 104, fontSize: 12, lineHeight: 18 },
  buildIdentityValue: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  moderationCard: { borderWidth: 1, gap: 12 },
  moderationHeading: { flexDirection: "row", alignItems: "center", gap: 8 },
  moderationHint: { fontSize: 12, lineHeight: 18 },
  accessibilityHeading: { flexDirection: "row", alignItems: "center", gap: 8 },
  accessibilityHint: { fontSize: 12, lineHeight: 18 },
  accessibilityOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 4,
  },
  accessibilityOptionCopy: { flex: 1, gap: 2 },
  accessibilityOptionTitle: { fontSize: 14, fontWeight: "600" as const },
  accessibilityOptionHint: { fontSize: 12, lineHeight: 17 },
  accessibilityToggle: {
    minWidth: 56,
    minHeight: 40,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  accessibilityToggleText: { fontSize: 13, fontWeight: "700" as const },
  fontScaleOptions: { flexDirection: "row", gap: 4 },
  fontScaleOption: {
    minWidth: 39,
    minHeight: 38,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  fontScaleOptionText: { fontSize: 11, fontWeight: "700" as const },
  moderationActions: { flexDirection: "row", gap: 10 },
  moderationButton: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  moderationButtonText: { fontSize: 13, fontWeight: "700" as const },
  moderationFeedback: { fontSize: 13, fontWeight: "600" as const, lineHeight: 19 },
  searchRow: { flexDirection: "row", gap: 10 },
  searchBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchResults: { borderWidth: 1, borderRadius: 10, overflow: "hidden" },
  searchResultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  searchResultEmoji: { fontSize: 22 },
  searchResultInfo: { flex: 1, gap: 2 },
  searchResultName: { fontSize: 14, fontWeight: "600" as const },
  searchResultMeta: { fontSize: 12 },
  searchResultBadge: { fontSize: 11, fontWeight: "700" as const },
  filterHistoryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: 1,
  },
  filterHistoryChipText: { fontSize: 11, fontWeight: "600" as const },
  selectedAccount: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderWidth: 1,
  },
  historyList: { gap: 8 },
  historyRow: { borderBottomWidth: 1, paddingBottom: 8, gap: 2 },
  historyText: { fontSize: 13, lineHeight: 19 },
  historyActorLink: { fontWeight: "600" as const, textDecorationLine: "underline" as const },
  historyMeta: { fontSize: 11 },
  historyFilterRow: { flexDirection: "row", gap: 10 },
  historyFilterInput: { flex: 1, height: 40, fontSize: 14 },
  historyFilterActions: { flexDirection: "row", gap: 10 },
  historyFilterButton: {
    minHeight: 36,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  historyFilterButtonText: { fontSize: 12, fontWeight: "700" as const },
  historyLoadMore: {
    minHeight: 40,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
});
