import * as SecureStore from "expo-secure-store";
import type { Session } from "@agora/core";

// Kept separate from the zustand session module so headless notification tasks
// can read credentials without starting React, registration, or UI effects.
export const KEY_URL = "agora_server_url";
export const KEY_TOKEN = "agora_admin_key";
const KEY_REGISTRATION = "agora_notification_registration_v1";

export interface ActionRegistration {
  baseUrl: string;
  context: string;
  username: string;
}

let epoch = 0;
export function registrationEpoch() { return epoch; }

export async function clearActionRegistration() {
  epoch += 1;
  await SecureStore.deleteItemAsync(KEY_REGISTRATION);
}

export async function readActionRegistration(): Promise<ActionRegistration | null> {
  const raw = await SecureStore.getItemAsync(KEY_REGISTRATION);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value.baseUrl !== "string" || typeof value.username !== "string" ||
        typeof value.context !== "string" || !/^[a-f0-9]{32}$/.test(value.context)) return null;
    return value;
  } catch { return null; }
}

export async function currentStoredSession(): Promise<Session | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(KEY_URL), SecureStore.getItemAsync(KEY_TOKEN),
  ]);
  return baseUrl && token ? { baseUrl, token } : null;
}

export async function saveActionRegistration(registration: ActionRegistration, session: Session, started: number) {
  const current = await currentStoredSession();
  if (started !== epoch || current?.baseUrl !== session.baseUrl || current.token !== session.token) return false;
  await SecureStore.setItemAsync(KEY_REGISTRATION, JSON.stringify(registration));
  // If sign-out raced the keychain write, remove the obsolete binding again.
  if (started !== epoch) { await SecureStore.deleteItemAsync(KEY_REGISTRATION); return false; }
  return true;
}
