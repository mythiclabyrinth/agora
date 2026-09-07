import {
  notificationActionOutcome, notificationActionSlot, parseNotificationActions, notificationMessageId,
} from "@agora/core/src/notifications/actions";
import type { Message } from "@agora/core/src/api/types";
import type { Session } from "@agora/core/src/api/client";
import type { ActionRegistration } from "./notificationRegistration";

export type ActionResult = "recorded" | "handled" | "retry" | "open" | "ignored";
type Credentials = { session: Session; registration: ActionRegistration };

/** Pure dispatcher: the platform adapter owns delivery and feedback. Requests
    are bounded and lost responses reconcile because they can follow
    a successful commit. Server locks make concurrent OS callbacks harmless. */
export async function executeNotificationAction(
  data: unknown,
  identifier: string,
  readCredentials: () => Promise<Credentials | null>,
  request: typeof fetch = fetch,
): Promise<ActionResult> {
  const envelope = parseNotificationActions(data);
  const slot = notificationActionSlot(identifier);
  if (!envelope || slot === null || !envelope.actions[slot]) return "ignored";
  const credentials = await readCredentials();
  if (!credentials || credentials.registration.context !== envelope.context ||
      credentials.session.baseUrl !== credentials.registration.baseUrl) return "open";
  const { session, registration } = credentials;
  const action = envelope.actions[slot];
  const messageId = notificationMessageId(data);
  const url = `${session.baseUrl}/api/messages/${messageId}`;
  const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  const bounded = async (target: string, init?: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await request(target, { ...init, headers, signal: controller.signal, redirect: "error" });
      // Keep the deadline active through body decoding, not just receipt of
      // headers. A stalled response must not strand a headless task.
      const body: unknown = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body };
    }
    finally { clearTimeout(timeout); }
  };
  const inspect = async (): Promise<ActionResult | "pending"> => {
    const response = await bounded(url);
    if (response.status === 401 || response.status === 403 || response.status === 404) return "open";
    if (!response.ok) return "retry";
    const message = response.body as Message | null;
    if (!message || message.id !== messageId) return "open";
    const outcome = notificationActionOutcome(message, action, registration.username);
    return outcome === "stale" ? "open" : outcome;
  };
  try {
    // Credential reads can overlap account switching; recheck before sending.
    const current = await readCredentials();
    if (current?.registration.context !== envelope.context || current.session.token !== session.token ||
        current.session.baseUrl !== session.baseUrl) return "open";
    const response = await bounded(`${url}/notification_action`, {
      method: "POST",
      body: JSON.stringify({ version: 1, context: envelope.context, category: envelope.category, action }),
    });
    const outcome = (response.body as { outcome?: unknown } | null)?.outcome;
    if (response.ok && (outcome === "recorded" || outcome === "already_recorded")) return "recorded";
    if (response.status === 401 || response.status === 403 || response.status === 404) return "open";
    const message = (response.body as { message?: Message } | null)?.message;
    if (response.status === 409 && message?.id === messageId) {
      const state = notificationActionOutcome(message, action, registration.username);
      return state === "stale" || state === "pending" ? "open" : state;
    }
    const after = await inspect();
    // A 409 with pending state means the category/registration changed.
    return after === "pending" ? (response.status === 409 ? "open" : "retry") : after;
  } catch {
    try {
      const after = await inspect();
      return after === "pending" ? "retry" : after;
    } catch { return "retry"; }
  }
}
