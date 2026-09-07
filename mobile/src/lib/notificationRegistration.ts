import * as SecureStore from "expo-secure-store";
import type { Session } from "@agora/core";

// Kept separate from the zustand session module so headless notification tasks
// can read credentials without starting React, registration, or UI effects.
export const KEY_URL = "agora_server_url_v2";
export const KEY_TOKEN = "agora_admin_key_v2";
const KEY_REGISTRATION = "agora_notification_registration_v2";
const legacyKeys = {
  [KEY_URL]: ["agora_server_url"],
  [KEY_TOKEN]: ["agora_admin_key", "agora_owner_token"],
  [KEY_REGISTRATION]: ["agora_notification_registration_v1"],
} as const;
type CredentialKey = keyof typeof legacyKeys;
const accessible = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export interface ActionRegistration {
  baseUrl: string;
  context: string;
  username: string;
}

let epoch = 0;
export function registrationEpoch() { return epoch; }

// The existing epoch invalidates work on account changes. Ordering keychain
// operations also prevents a late migration write from overtaking deletion.
let storage: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = storage.then(operation);
  storage = result.catch(() => {});
  return result;
}

async function removeCopies(key: CredentialKey) {
  await Promise.all([key, ...legacyKeys[key]].map((name) => SecureStore.deleteItemAsync(name)));
}

async function readStored(key: CredentialKey, started: number): Promise<string | null> {
  const current = await SecureStore.getItemAsync(key);
  if (started !== epoch) return null;
  if (current !== null) return current;
  for (const legacyKey of legacyKeys[key]) {
    const legacy = await SecureStore.getItemAsync(legacyKey);
    if (started !== epoch) return null;
    if (legacy === null) continue;
    try {
      await SecureStore.setItemAsync(key, legacy, accessible);
    } catch {
      // Keep sign-in usable if migration fails. Capability preparation below
      // separately verifies the new keys before advertising action support.
      return started === epoch ? legacy : null;
    }
    if (started !== epoch) {
      await SecureStore.deleteItemAsync(key);
      return null;
    }
    // A cleanup failure is recoverable: new reads prefer v2 and logout deletes
    // every copy. Never destroy the only credential before writing its successor.
    await Promise.all(legacyKeys[key].map((name) => SecureStore.deleteItemAsync(name).catch(() => {})));
    return started === epoch ? legacy : null;
  }
  return null;
}

export function readCredential(key: CredentialKey): Promise<string | null> {
  const started = epoch;
  return serialized(() => readStored(key, started));
}

export function writeCredential(key: CredentialKey, value: string, started = epoch): Promise<void> {
  return serialized(async () => {
    if (started !== epoch) throw new Error("Session changed while storing credentials");
    await SecureStore.setItemAsync(key, value, accessible);
    if (started !== epoch) {
      await SecureStore.deleteItemAsync(key);
      throw new Error("Session changed while storing credentials");
    }
    await Promise.all(legacyKeys[key].map((name) => SecureStore.deleteItemAsync(name).catch(() => {})));
  });
}

export function deleteCredential(key: CredentialKey): Promise<void> {
  return serialized(() => removeCopies(key));
}

export async function clearActionRegistration() {
  epoch += 1;
  await deleteCredential(KEY_REGISTRATION);
}

export async function readActionRegistration(): Promise<ActionRegistration | null> {
  const raw = await readCredential(KEY_REGISTRATION);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value.baseUrl !== "string" || typeof value.username !== "string" ||
        typeof value.context !== "string" || !/^[a-f0-9]{32}$/.test(value.context)) return null;
    return value;
  } catch { return null; }
}

export async function currentStoredSession(): Promise<Session | null> {
  const started = epoch;
  return serialized(async () => {
    const baseUrl = await readStored(KEY_URL, started);
    const token = await readStored(KEY_TOKEN, started);
    return started === epoch && baseUrl && token ? { baseUrl, token } : null;
  });
}

export async function prepareNotificationCredentials(session: Session): Promise<boolean> {
  const started = epoch;
  return serialized(async () => {
    await readStored(KEY_URL, started);
    await readStored(KEY_TOKEN, started);
    const registration = await readStored(KEY_REGISTRATION, started);
    const [baseUrl, token, storedRegistration] = await Promise.all([
      SecureStore.getItemAsync(KEY_URL), SecureStore.getItemAsync(KEY_TOKEN), SecureStore.getItemAsync(KEY_REGISTRATION),
    ]);
    return started === epoch && baseUrl === session.baseUrl && token === session.token &&
      registration === storedRegistration;
  }).catch(() => false);
}

export async function saveActionRegistration(registration: ActionRegistration, session: Session, started: number) {
  const current = await currentStoredSession();
  if (started !== epoch || current?.baseUrl !== session.baseUrl || current.token !== session.token) return false;
  await writeCredential(KEY_REGISTRATION, JSON.stringify(registration), started);
  return started === epoch;
}
