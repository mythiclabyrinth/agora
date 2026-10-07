import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eventCombo, findConflicts, formatCombo, matchesCombo, nextSequence, nextUnreadIndex, parseCombo, SHORTCUTS, shortcutById } from "./shortcuts";

describe("shortcut bindings", () => {
  it("matches physical keys with platform-specific Mod", () => {
    const mac = { code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchesCombo("Mod+KeyK", mac, "mac")).toBe(true);
    expect(matchesCombo("Mod+KeyK", mac, "other")).toBe(false);
    expect(eventCombo(mac, "mac")).toBe("Mod+KeyK");
    expect(formatCombo("Mod+Shift+KeyK", "mac")).toBe("⌘⇧K");
    expect(formatCombo("Mod+Shift+KeyK", "other")).toBe("Ctrl+Shift+K");
    expect(parseCombo("Mod+KeyK", "other")?.ctrl).toBe(true);
    expect(matchesCombo("Mod+KeyK", { ...mac, code: "KeyV", key: "k" }, "mac")).toBe(true);
    expect(eventCombo({ ...mac, code: "KeyV", key: "k" }, "mac")).toBe("Mod+KeyK");
    expect(matchesCombo("Mod+Slash", { ...mac, code: "Slash", key: "z" }, "mac")).toBe(false);
    expect(eventCombo({ ...mac, code: "Slash", key: "z" }, "mac")).toBe("Mod+KeyZ");
    expect(matchesCombo("Mod+Slash", { ...mac, code: "Slash", key: "-" }, "mac")).toBe(false);
    expect(matchesCombo("Mod+Slash", { ...mac, code: "Slash", key: "/" }, "mac")).toBe(true);
    expect(matchesCombo("Mod+Shift+Comma", { ...mac, code: "Comma", key: "<", shiftKey: true }, "mac")).toBe(true);
    expect(eventCombo({ ...mac, code: "Slash", key: "-" }, "mac")).toBe("Mod+Unidentified");
  });

  it("recognizes only registered sequence prefixes", () => {
    expect(nextSequence("", "g")).toBe("G");
    expect(nextSequence("G", "t")).toBe("G T");
    expect(nextSequence("G", "z")).toBeNull();
  });

  it("blocks unsafe and reserved combinations and reports overlaps", () => {
    expect(findConflicts("search", "Mod+KeyW", "mac")[0].kind).toBe("blocked");
    expect(findConflicts("search", "Mod+Shift+KeyT", "mac")[0].kind).toBe("blocked");
    expect(findConflicts("search", "Mod+Comma", "mac", {}, true)[0].kind).toBe("blocked");
    expect(findConflicts("search", "Mod+Comma", "other", {}, true)[0].kind).toBe("blocked");
    expect(findConflicts("search", "Alt+KeyL", "mac")[0].kind).toBe("blocked");
    expect(findConflicts("search", "Mod+Alt+KeyL", "other")[0].kind).toBe("blocked");
    expect(findConflicts("search", "Mod+KeyP", "mac")[0].kind).toBe("warning");
    expect(findConflicts("search", "Mod+KeyV", "mac")[0]).toMatchObject({ kind: "blocked", message: "Reserved for text editing" });
    expect(findConflicts("search", "Mod+Shift+KeyZ", "other")[0].kind).toBe("blocked");
    expect(findConflicts("search", "Mod+BracketLeft", "mac", {}, false).some(c => c.kind === "duplicate")).toBe(false);
    expect(findConflicts("search", "Mod+Shift+KeyU", "mac")).toContainEqual(expect.objectContaining({ kind: "duplicate", withId: "nav.unreads" }));
    expect(findConflicts("search", "KeyP", "mac")[0].kind).toBe("blocked");
  });

  it("cycles unread channels and threads", () => {
    const rows = [{ channel_id: "a", thread_id: null }, { channel_id: "a", thread_id: 3 }, { channel_id: "b", thread_id: null }];
    expect(nextUnreadIndex(rows, { channelId: "a", threadId: 3 }, 1)).toBe(2);
    expect(nextUnreadIndex(rows, { channelId: "a", threadId: null }, -1)).toBe(2);
    expect(nextUnreadIndex([], {}, 1)).toBe(-1);
  });

  it("limits history navigation to desktop", () => {
    expect(shortcutById("nav.back")?.desktopOnly).toBe(true);
    expect(shortcutById("nav.forward")?.desktopOnly).toBe(true);
  });

  it("keeps documented defaults in sync", () => {
    const path = fileURLToPath(new URL("../../../../docs/site/keyboard-shortcuts.md", import.meta.url));
    const lines = readFileSync(path, "utf8").split("\n");
    for (const shortcut of SHORTCUTS) {
      const line = lines.find(line => line.includes(`(\`${shortcut.id}\`)`));
      expect(line, shortcut.id).toBeDefined();
      if (shortcut.keys.mac) expect(line).toContain(formatCombo(shortcut.keys.mac, "mac"));
      if (shortcut.keys.other) expect(line).toContain(formatCombo(shortcut.keys.other, "other"));
      if (shortcut.sequence) expect(line).toContain(shortcut.sequence);
    }
  });
});
