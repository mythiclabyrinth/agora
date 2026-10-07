/** Keyboard bindings shared by the web app, desktop webview, and help text. */
export type ShortcutScope = "global" | "notTyping" | "composer" | "thread" | "inbox" | "recording";
export type Platform = "mac" | "other";
export interface Shortcut {
  id: string;
  section: string;
  label: string;
  keys: { mac?: string; other?: string };
  scope: ShortcutScope;
  sequence?: string;
  rebindable?: boolean;
  desktopOnly?: boolean;
  feature?: "voice_stt";
}

// Mod is Command on macOS and Control elsewhere. Codes name physical keys.
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "help.sheet", section: "Navigation", label: "Keyboard shortcuts", keys: { mac: "Mod+Slash", other: "Mod+Slash" }, scope: "global", sequence: "?", rebindable: true },
  { id: "search", section: "Navigation", label: "Search conversations", keys: { mac: "Mod+KeyK", other: "Mod+KeyK" }, scope: "global", rebindable: true },
  { id: "nav.inbox", section: "Navigation", label: "Go to Inbox", keys: {}, scope: "notTyping", sequence: "G I" },
  { id: "nav.unreads", section: "Navigation", label: "Go to Unreads", keys: { mac: "Mod+Shift+KeyU", other: "Mod+Shift+KeyU" }, scope: "global", sequence: "G U", rebindable: true },
  { id: "nav.threads", section: "Navigation", label: "Go to Threads", keys: { mac: "Mod+Shift+KeyL", other: "Mod+Shift+KeyL" }, scope: "global", sequence: "G T", rebindable: true },
  ...(["All", "Mentions", "Channels", "Threads"] as const).map((label, i): Shortcut => ({ id: `inbox.filter${i + 1}`, section: "Inbox", label: `${label} unread filter`, keys: { mac: `Digit${i + 1}`, other: `Digit${i + 1}` }, scope: "inbox" })),
  { id: "agents.picker", section: "Composer & agents", label: "Talk to agents", keys: { mac: "Mod+Shift+Digit2", other: "Mod+Shift+Digit2" }, scope: "composer", rebindable: true },
  { id: "thread.requireMention", section: "Composer & agents", label: "Require @mention", keys: { mac: "Mod+Shift+KeyX", other: "Mod+Shift+KeyX" }, scope: "thread", rebindable: true },
  { id: "voice.toggle", section: "Voice", label: "Record / add to message", keys: { mac: "Mod+Shift+Space", other: "Mod+Shift+Space" }, scope: "composer", feature: "voice_stt", rebindable: true },
  { id: "voice.send", section: "Voice", label: "Stop and send recording", keys: { mac: "Mod+Enter", other: "Mod+Enter" }, scope: "recording", feature: "voice_stt", rebindable: true },
  { id: "voice.cancel", section: "Voice", label: "Discard recording", keys: { mac: "Escape", other: "Escape" }, scope: "recording", feature: "voice_stt" },
  { id: "nav.prevChannel", section: "Navigation", label: "Previous channel", keys: { mac: "Alt+ArrowUp", other: "Alt+ArrowUp" }, scope: "notTyping", rebindable: true },
  { id: "nav.nextChannel", section: "Navigation", label: "Next channel", keys: { mac: "Alt+ArrowDown", other: "Alt+ArrowDown" }, scope: "notTyping", rebindable: true },
  { id: "nav.prevUnread", section: "Navigation", label: "Previous unread", keys: { mac: "Alt+Shift+ArrowUp", other: "Alt+Shift+ArrowUp" }, scope: "notTyping", rebindable: true },
  { id: "nav.nextUnread", section: "Navigation", label: "Next unread", keys: { mac: "Alt+Shift+ArrowDown", other: "Alt+Shift+ArrowDown" }, scope: "notTyping", rebindable: true },
  { id: "read.markChannel", section: "Inbox", label: "Mark channel read", keys: { mac: "Escape", other: "Escape" }, scope: "notTyping" },
  { id: "read.markAll", section: "Inbox", label: "Mark all read", keys: { mac: "Shift+Escape", other: "Shift+Escape" }, scope: "notTyping" },
  { id: "focus.composer", section: "Composer & agents", label: "Focus composer", keys: { mac: "Enter", other: "Enter" }, scope: "notTyping" },
  { id: "thread.close", section: "Composer & agents", label: "Close thread", keys: { mac: "Escape", other: "Escape" }, scope: "thread" },
  { id: "thread.expand", section: "Composer & agents", label: "Expand or shrink thread", keys: { mac: "Mod+Shift+Backslash", other: "Mod+Shift+Backslash" }, scope: "thread", rebindable: true },
  { id: "ui.sidebar", section: "Navigation", label: "Toggle sidebar", keys: { mac: "Mod+Shift+KeyD", other: "Mod+Shift+KeyD" }, scope: "global", rebindable: true },
  { id: "nav.back", section: "Navigation", label: "Back", keys: { mac: "Mod+BracketLeft", other: "Alt+ArrowLeft" }, scope: "global", rebindable: true, desktopOnly: true },
  { id: "nav.forward", section: "Navigation", label: "Forward", keys: { mac: "Mod+BracketRight", other: "Alt+ArrowRight" }, scope: "global", rebindable: true, desktopOnly: true },
  { id: "link.copy", section: "Navigation", label: "Copy conversation link", keys: { mac: "Mod+Shift+KeyY", other: "Mod+Shift+KeyY" }, scope: "global", rebindable: true },
  { id: "settings", section: "Navigation", label: "Settings", keys: { mac: "Mod+Shift+Comma", other: "Mod+Shift+Comma" }, scope: "global", sequence: "G S", rebindable: true },
];

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform || "");
export const currentPlatform = (): Platform => isMac() ? "mac" : "other";
export const shortcutById = (id: string): Shortcut | undefined => SHORTCUTS.find(s => s.id === id);

const punctuation: Record<string, readonly [string, string]> = {
  Slash: ["/", "?"], Comma: [",", "<"], Backslash: ["\\", "|"],
  BracketLeft: ["[", "{"], BracketRight: ["]", "}"],
};
function eventCode(event: Pick<KeyboardEvent, "code" | "shiftKey"> & Partial<Pick<KeyboardEvent, "key">>): string {
  if (/^[a-z]$/i.test(event.key || "")) return `Key${event.key!.toUpperCase()}`;
  const expected = punctuation[event.code]?.[event.shiftKey ? 1 : 0];
  if (expected && event.key && event.key !== expected) return "Unidentified";
  return event.code;
}

export function parseCombo(combo: string, platform: Platform): { code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean } | null {
  const parts = combo.split("+");
  const code = parts.pop();
  if (!code || !/^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Slash|Comma|Backslash|Bracket(Left|Right)|Space|Enter|Escape|Backspace|F([1-9]|1[0-2]))$/.test(code)) return null;
  const flags = new Set(parts);
  if (flags.size !== parts.length || [...flags].some(p => !["Mod", "Meta", "Ctrl", "Alt", "Shift"].includes(p))) return null;
  return { code, meta: flags.has("Meta") || (platform === "mac" && flags.has("Mod")), ctrl: flags.has("Ctrl") || (platform === "other" && flags.has("Mod")), alt: flags.has("Alt"), shift: flags.has("Shift") };
}

export function eventCombo(event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & Partial<Pick<KeyboardEvent, "key">>, platform: Platform): string {
  const modifiers = [event.metaKey && (platform === "mac" ? "Mod" : "Meta"), event.ctrlKey && (platform === "other" ? "Mod" : "Ctrl"), event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  const code = eventCode(event);
  return [...modifiers, code].join("+");
}

export function matchesCombo(combo: string | undefined, event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & Partial<Pick<KeyboardEvent, "key">>, platform: Platform): boolean {
  if (!combo) return false;
  const parsed = parseCombo(combo, platform);
  const code = eventCode(event);
  return !!parsed && parsed.code === code && parsed.meta === event.metaKey && parsed.ctrl === event.ctrlKey && parsed.alt === event.altKey && parsed.shift === event.shiftKey;
}

export function formatCombo(combo: string | undefined, platform: Platform): string {
  if (!combo) return "";
  const parts = combo.split("+");
  const code = parts.pop() || "";
  const key = code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : ({ Slash: "/", Comma: ",", Space: "Space", Enter: platform === "mac" ? "↩" : "Enter", Escape: "Esc", Backslash: "\\", BracketLeft: "[", BracketRight: "]", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" } as Record<string, string>)[code] || code;
  return platform === "mac"
    ? parts.map(p => ({ Mod: "⌘", Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" } as Record<string, string>)[p] || p).join("") + key
    : [...parts.map(p => p === "Mod" ? "Ctrl" : p), key].join("+");
}

export function ariaCombo(combo: string | undefined, platform: Platform): string | undefined {
  if (!combo) return undefined;
  const parsed = parseCombo(combo, platform);
  if (!parsed) return undefined;
  const key = parsed.code.startsWith("Key") ? parsed.code.slice(3) : parsed.code.startsWith("Digit") ? parsed.code.slice(5) : ({ Slash: "/", Comma: ",", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Space: "Space" } as Record<string, string>)[parsed.code] || parsed.code;
  return [parsed.meta && "Meta", parsed.ctrl && "Control", parsed.alt && "Alt", parsed.shift && "Shift", key].filter(Boolean).join("+");
}

export function nextSequence(prefix: string, key: string): string | null {
  const next = prefix ? `${prefix} ${key.toUpperCase()}` : key.toUpperCase();
  return SHORTCUTS.some(s => s.sequence?.startsWith(next)) ? next : null;
}

export type Conflict = { kind: "duplicate" | "blocked" | "warning"; message: string; withId?: string };
const overlap = (a: ShortcutScope, b: ShortcutScope): boolean => a === b || a === "global" || b === "global" ||
  a === "notTyping" || b === "notTyping" ||
  (a === "composer" && (b === "thread" || b === "recording")) ||
  (b === "composer" && (a === "thread" || a === "recording")) ||
  (a === "thread" && b === "recording") || (b === "thread" && a === "recording");
export function findConflicts(id: string, combo: string, platform: Platform, bindings: Record<string, string | null> = {}, desktop = false): Conflict[] {
  const shortcut = shortcutById(id);
  const parsed = parseCombo(combo, platform);
  if (!shortcut || !shortcut.rebindable || !parsed) return [{ kind: "blocked", message: "Choose a valid shortcut" }];
  if (!parsed.meta && !parsed.ctrl && !parsed.alt) return [{ kind: "blocked", message: "Use a modifier key" }];
  if (platform === "mac" && parsed.alt && /^(Key[A-Z]|Digit[0-9]|Space|Slash|Comma|Backslash|BracketLeft|BracketRight)$/.test(parsed.code)) return [{ kind: "blocked", message: "Option with printable keys types characters on some keyboards" }];
  if (platform === "other" && parsed.ctrl && parsed.alt && /^(Key[A-Z]|Digit[0-9]|Space|Slash|Comma|Backslash|BracketLeft|BracketRight)$/.test(parsed.code)) return [{ kind: "blocked", message: "Ctrl+Alt types characters on some keyboards" }];
  const canonical = eventCombo({ code: parsed.code, metaKey: parsed.meta, ctrlKey: parsed.ctrl, altKey: parsed.alt, shiftKey: parsed.shift }, platform);
  if (["Mod+KeyC", "Mod+KeyV", "Mod+KeyX", "Mod+KeyZ", "Mod+KeyA", "Mod+KeyY", "Mod+Shift+KeyZ"].includes(canonical)) {
    return [{ kind: "blocked", message: "Reserved for text editing" }];
  }
  const blocked = platform === "mac" ? ["Mod+KeyW", "Mod+KeyQ", "Mod+KeyT", "Mod+KeyN", "Mod+KeyH", "Mod+KeyM", "Mod+Comma", "Mod+Shift+KeyT", "Mod+Shift+KeyN", "Mod+Shift+KeyW", "Mod+Shift+Digit3", "Mod+Shift+Digit4", "Mod+Shift+Digit5"] : ["Mod+KeyW", "Mod+KeyT", "Mod+KeyN", "Mod+Shift+KeyT", "Mod+Shift+KeyN", "Mod+Shift+KeyW", "Alt+F4"];
  if (blocked.includes(canonical) || (desktop && canonical === "Mod+Comma")) return [{ kind: "blocked", message: "Reserved by the browser or operating system" }];
  const result: Conflict[] = [];
  const warned = platform === "mac" ? ["Mod+KeyL", "Mod+KeyR", "Mod+KeyP", "Mod+KeyS", "Mod+KeyF", "Mod+KeyD", "Mod+KeyJ"] : ["Mod+Shift+KeyI", "Mod+Shift+KeyJ", "Mod+Shift+KeyC", "Mod+Shift+KeyM", "Mod+Shift+KeyA", "Mod+Shift+KeyO", "Mod+Shift+KeyB", "Mod+Shift+KeyY"];
  if (warned.includes(canonical)) result.push({ kind: "warning", message: "This may override a browser shortcut" });
  for (const other of SHORTCUTS) {
    if (other.desktopOnly && !desktop) continue;
    if (other.id === id || !overlap(shortcut.scope, other.scope)) continue;
    if ((bindings[other.id] === undefined ? other.keys[platform] : bindings[other.id]) === canonical) result.push({ kind: "duplicate", message: `Used by ${other.label}`, withId: other.id });
  }
  return result;
}

/** Cycle across unread inbox rows, preserving the server's channel/thread order. */
export function nextUnreadIndex<T extends { channel_id: string; thread_id: number | null }>(items: readonly T[], current: { channelId?: string | null; threadId?: number | null }, direction: 1 | -1): number {
  if (!items.length) return -1;
  const at = items.findIndex(item => item.channel_id === current.channelId && item.thread_id === (current.threadId ?? null));
  return at === -1 ? (direction === 1 ? 0 : items.length - 1) : (at + direction + items.length) % items.length;
}
