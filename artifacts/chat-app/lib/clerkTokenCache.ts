import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const webTokens = new Map<string, string>();

function removePersistedWebToken(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export const clerkTokenCache = {
  async getToken(key: string) {
    if (Platform.OS === "web") {
      removePersistedWebToken(key);
      return webTokens.get(key) ?? null;
    }
    return SecureStore.getItemAsync(key);
  },
  async saveToken(key: string, token: string) {
    if (Platform.OS === "web") {
      removePersistedWebToken(key);
      webTokens.set(key, token);
      return;
    }
    await SecureStore.setItemAsync(key, token);
  },
  async clearToken(key: string) {
    if (Platform.OS === "web") {
      webTokens.delete(key);
      removePersistedWebToken(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};