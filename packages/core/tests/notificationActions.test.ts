import { describe, expect, it } from "vitest";
import fixtures from "../testing/notification-actions.json";
import {
  notificationActionSlot, notificationCategories, notificationIsResolved,
  parseNotificationActions, hasPendingInteraction, notificationMessageId,
} from "../src/notifications/actions";
import type { Message, MessageMeta } from "../src/api/types";

const context = "a".repeat(32);
const data = () => ({ message_id: 42, pending_interaction: true,
  notification_actions: { ...structuredClone(fixtures[0].expected), context } });

describe("notification contract shared with Rust", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const envelope = fixture.expected ? { ...fixture.expected, context } : null;
      expect(parseNotificationActions({ message_id: 42, notification_actions: envelope })).toEqual(envelope);
      const meta = fixture.meta as unknown as MessageMeta;
      expect(hasPendingInteraction(meta)).toBe(fixture.pending);
      // Feedback removes notification_actions from tap-to-open reminder cards.
      for (const message_id of [42, "42"]) {
        expect(notificationIsResolved({ message_id, pending_interaction: true },
          { id: 42, meta } as Message)).toBe(!fixture.pending);
      }
    });
  }

  it("has unique immutable category and slot identifiers", () => {
    expect(new Set(notificationCategories.map((c) => c.identifier)).size).toBe(notificationCategories.length);
    for (const c of notificationCategories) {
      expect(c.actions.length).toBeLessThanOrEqual(4);
      expect(c.actions.map((a) => notificationActionSlot(a.identifier))).toEqual(c.actions.map((_, i) => i));
    }
    for (const invalid of ["0", "agora.action.4", "agora.action.01", "default"]) {
      expect(notificationActionSlot(invalid)).toBeNull();
    }
  });

  it("normalizes delivered string ids without accepting invalid message ids", () => {
    expect(parseNotificationActions({ ...data(), message_id: "42" })).toEqual(data().notification_actions);
    for (const message_id of [null, undefined, "", " ", "abc", "1.2", 1.2, 0, "0", -1, "-1", Infinity, "Infinity", Number.MAX_SAFE_INTEGER + 1, true, {}, []]) {
      expect(notificationMessageId({ message_id })).toBeNull();
      expect(parseNotificationActions({ ...data(), message_id })).toBeNull();
    }
  });

  it("rejects unknown versions, mismatched labels, role masks, ids and categories", () => {
    for (const modify of [
      (d: any) => { d.notification_actions.version = 2; },
      (d: any) => { d.notification_actions.category = "unknown"; },
      (d: any) => { d.notification_actions.actions[0].label = "Deploy"; },
      (d: any) => { d.notification_actions.actions[0].destructive = true; },
      (d: any) => { d.notification_actions.actions[1].id = "allow"; },
      (d: any) => { d.message_id = 1.2; },
      (d: any) => { d.notification_actions.context = ""; },
    ]) {
      const invalid = data(); modify(invalid);
      expect(parseNotificationActions(invalid)).toBeNull();
    }
  });

  it("recognizes completion on another device without relying on read markers", () => {
    const message = { id: 42, meta: structuredClone(fixtures[0].meta) } as Message;
    expect(notificationIsResolved(data(), message)).toBe(false);
    message.meta!.resolved = { option_id: "allow", by: "someone-else" };
    expect(notificationIsResolved(data(), message)).toBe(true);
    expect(notificationIsResolved({ ...data(), message_id: 43 }, message)).toBe(false);
  });
});
