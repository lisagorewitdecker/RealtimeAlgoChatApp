import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const webTokens = new Map<string, string>();

export const clerkTokenCache = {
  async getToken(key: string) {
    if (Platform.OS === "web") return webTokens.get(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async saveToken(key: string, token: string) {
    if (Platform.OS === "web") {
      webTokens.set(key, token);
      return;
    }
    await SecureStore.setItemAsync(key, token);
  },
  async clearToken(key: string) {
    if (Platform.OS === "web") {
      webTokens.delete(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};