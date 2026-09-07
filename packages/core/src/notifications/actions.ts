import vocabulary from "./categories.json";
import type { Message, MessageMeta } from "../api/types";

export type NotificationActionKind = "select" | "form_submit" | "table_submit";
export interface NotificationAction {
  kind: NotificationActionKind;
  id: string;
  interaction_id: string;
  label: string;
  destructive: boolean;
}
export interface NotificationActions {
  version: 1;
  context: string;
  category: string;
  actions: NotificationAction[];
}

/** Category ids are immutable. Every destructive-mask variant is registered
    ahead of delivery; the push never supplies arbitrary native action titles. */
export const notificationCategories = vocabulary.flatMap(({ id, labels }) =>
  Array.from({ length: 1 << labels.length }, (_, mask) => ({
    identifier: `agora.v1.${id}.d${mask}`,
    actions: labels.map((label, slot) => ({
      identifier: `agora.action.${slot}`,
      buttonTitle: label,
      options: { opensAppToForeground: false, isDestructive: !!(mask & (1 << slot)) },
    })),
  })),
);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Delivered notification data can encode numeric ids as strings. */
export function notificationNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function notificationMessageId(data: unknown): number | null {
  const id = record(data) ? notificationNumber(data.message_id) : null;
  return id !== null && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function notificationContext(data: unknown): string | null {
  if (!record(data)) return null;
  if (typeof data.notification_context === "string") return data.notification_context;
  return record(data.notification_actions) && typeof data.notification_actions.context === "string"
    ? data.notification_actions.context : null;
}

export function parseNotificationActions(data: unknown): NotificationActions | null {
  if (!record(data) || notificationMessageId(data) === null) return null;
  const envelope = data.notification_actions;
  if (!record(envelope) || envelope.version !== 1 ||
      typeof envelope.context !== "string" || !/^[a-f0-9]{32}$/.test(envelope.context) ||
      !Array.isArray(envelope.actions)) return null;
  const category = notificationCategories.find((c) => c.identifier === envelope.category);
  if (!category || envelope.actions.length !== category.actions.length) return null;
  const ids = new Set<string>();
  for (const [index, action] of envelope.actions.entries()) {
    if (!record(action) || !["select", "form_submit", "table_submit"].includes(String(action.kind)) ||
        typeof action.id !== "string" || !action.id || action.id.length > 256 ||
        typeof action.interaction_id !== "string" || action.interaction_id.length > 1024 ||
        action.label !== category.actions[index].buttonTitle ||
        action.destructive !== category.actions[index].options.isDestructive) return null;
    const key = `${action.kind}:${action.id}`;
    if (ids.has(key)) return null;
    ids.add(key);
  }
  return envelope as unknown as NotificationActions;
}

export function notificationActionSlot(identifier: string): number | null {
  const match = /^agora\.action\.([0-3])$/.exec(identifier);
  return match ? Number(match[1]) : null;
}

export function interactionResolution(meta: MessageMeta | null | undefined, kind: NotificationActionKind) {
  if (kind === "select") return meta?.resolved;
  if (kind === "form_submit") return meta?.form_submitted;
  return meta?.table_submitted;
}

export function interactionId(meta: MessageMeta | null | undefined, kind: NotificationActionKind): string {
  return (kind === "select" ? meta?.options_id : kind === "form_submit" ? meta?.form_id : meta?.table_id) ?? "";
}

export function notificationActionOutcome(message: Message, action: NotificationAction, username: string) {
  if (interactionId(message.meta, action.kind) !== action.interaction_id) return "stale" as const;
  const done = interactionResolution(message.meta, action.kind);
  if (!done) return "pending" as const;
  const chosen = "option_id" in done ? done.option_id : done.button_id;
  return done.by === username && chosen === action.id ? "recorded" as const : "handled" as const;
}

export function hasPendingInteraction(meta?: MessageMeta | null): boolean {
  return !!((meta?.options?.length && !meta.resolved) ||
    (meta?.form && !meta.form_submitted) || (meta?.table && !meta.table_submitted &&
      (meta.table.buttons.length || meta.table.rows.some((row) => row.actions.length && !meta.table_rows?.[row.id]))));
}

export function notificationIsResolved(data: unknown, message: Message): boolean {
  if (!record(data) || notificationMessageId(data) !== message.id || !data.pending_interaction) return false;
  const actions = parseNotificationActions(data);
  if (!actions) return !hasPendingInteraction(message.meta);
  return actions.actions.every((action) =>
    interactionId(message.meta, action.kind) !== action.interaction_id ||
    !!interactionResolution(message.meta, action.kind));
}
