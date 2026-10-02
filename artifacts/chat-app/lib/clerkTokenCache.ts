import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

function webStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export const clerkTokenCache = {
  async getToken(key: string) {
    if (Platform.OS === "web") return webStorage()?.getItem(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async saveToken(key: string, token: string) {
    if (Platform.OS === "web") {
      webStorage()?.setItem(key, token);
      return;
    }
    await SecureStore.setItemAsync(key, token);
  },
  async clearToken(key: string) {
    if (Platform.OS === "web") {
      webStorage()?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};