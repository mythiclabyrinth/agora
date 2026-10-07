import { useEffect, useRef } from "react";
import { currentPlatform, matchesCombo, nextSequence, nextUnreadIndex, SHORTCUTS, useGroups, useMarkRead, useMarkUnreadsRead, useMe, useUnreads } from "@agora/core";
import { copyDeepLink } from "../lib/deepLinks";
import { useAddressing } from "../components/Composer";
import { useEmojiPicker } from "../components/EmojiPicker";
import { bindingFor, useShortcutState } from "../state/shortcuts";
import { navigateAgoraHistory, useUiState } from "../state/ui";
import { useVoiceRec, voiceCancel } from "../state/voiceRec";
import { hasOpenDialog } from "./useDialogFocus";
import { isDesktopShell } from "../lib/chime";

const editing = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
const typeTarget = (target: EventTarget | null) => target instanceof HTMLElement &&
  (target === document.body || target.matches(".agora-main, .agora-thread") || !!target.closest("#ago-log, #ago-thread-log")) &&
  !target.closest("button, a, [role='button'], [role='option'], [role='tab'], summary, [tabindex]:not(.agora-main):not(.agora-thread)");
let lastComposerKey: string | null = null;
let lastPointerZone: "thread" | "channel" | null = null;
let shortcutMode = false;
export function leaveComposerForShortcuts(zone: "thread" | "channel") {
  lastPointerZone = zone;
  shortcutMode = true;
}
export const overlayOpen = (ignorePicker = false) => {
  const ui = useUiState.getState();
  let popoverOpen = false;
  try { popoverOpen = !!document.querySelector("[popover]:popover-open"); } catch { /* older WebKit */ }
  return hasOpenDialog() || !!ui.panel || ui.searchOpen || useShortcutState.getState().sheetOpen ||
    (!ignorePicker && !!useAddressing.getState().pickerKey) || useEmojiPicker.getState().openFor != null ||
    popoverOpen || !!document.querySelector(".ago-image-lightbox, .ago-pin-pop, .tools-open, .ago-dm-popover, .ago-react-pop, .thread-resizing, #ago-sources-overlay, .ago-template-pop, [role='dialog']");
};
function composerKey(): string | null {
  const ui = useUiState.getState();
  if (!ui.sel.c || ui.view.kind !== "channel") return null;
  const focusedThread = !!(document.activeElement as HTMLElement | null)?.closest(".agora-thread");
  return ui.threadRoot != null && (lastPointerZone === "thread" || (lastPointerZone !== "channel" &&
    (ui.threadExpanded || (window.matchMedia("(max-width: 820px)").matches && ui.mobileView === "thread") || focusedThread || lastComposerKey === `t:${ui.threadRoot}`)))
    ? `t:${ui.threadRoot}` : `c:${ui.sel.c}`;
}
function commandComposer(id: string, key: string) {
  window.dispatchEvent(new CustomEvent("agora-composer-command", { detail: { id, key } }));
}
function typeIntoComposer(text: string, key = composerKey()): boolean {
  const input = document.getElementById(key?.startsWith("t:") ? "ago-thread-msg" : "ago-msg") as HTMLTextAreaElement | null;
  if (!input || !key || !input.getClientRects().length) return false;
  input.focus();
  const insertionEnd = input.selectionStart + text.length;
  if (document.execCommand?.("insertText", false, text)) {
    input.setSelectionRange(insertionEnd, insertionEnd);
    return true;
  }
  input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  input.setSelectionRange(insertionEnd, insertionEnd);
  return true;
}
function focusComposer(key = composerKey()): boolean {
  const input = document.getElementById(key?.startsWith("t:") ? "ago-thread-msg" : "ago-msg") as HTMLTextAreaElement | null;
  if (!key || !input?.getClientRects().length) return false;
  input.focus();
  return true;
}

export function useShortcuts(): void {
  const channelId = useUiState(s => s.sel.c);
  const threadRoot = useUiState(s => s.threadRoot);
  const groups = useGroups().data ?? [];
  const unreads = useUnreads();
  const me = useMe().data;
  const markRead = useMarkRead(channelId || "");
  const markAll = useMarkUnreadsRead();
  const latest = useRef({ groups, unreads, me, markRead, markAll, channelId });
  latest.current = { groups, unreads, me, markRead, markAll, channelId };

  useEffect(() => { useAddressing.getState().setPickerKey(null); }, [channelId, threadRoot]);

  useEffect(() => {
    lastComposerKey = null;
    lastPointerZone = null;
    shortcutMode = false;
    const platform = currentPlatform();
    let sequence = "";
    let pendingText = "";
    let startedFromTypeTarget = false;
    let startTarget: HTMLElement | null = null;
    let startChannel: string | null | undefined;
    let startThread: number | null;
    let startView = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => { sequence = ""; pendingText = ""; startedFromTypeTarget = false; startTarget = null; if (timer) clearTimeout(timer); timer = null; };
    const canForward = () => {
      const state = useUiState.getState();
      return startedFromTypeTarget && !overlayOpen() && state.sel.c === startChannel &&
        state.threadRoot === startThread && state.view.kind === startView &&
        (document.activeElement === startTarget || document.activeElement === document.body);
    };
    const run = (id: string): boolean => {
      const { groups, unreads, me, markRead, markAll, channelId } = latest.current;
      const state = useUiState.getState();
      const key = composerKey();
      switch (id) {
        case "help.sheet": useShortcutState.getState().setSheetOpen(!useShortcutState.getState().sheetOpen); return true;
        case "help.open": useShortcutState.getState().setSheetOpen(true); return true;
        case "search": if (!state.searchOpen) useShortcutState.getState().setSheetOpen(false); state.setSearchOpen(!state.searchOpen); return true;
        case "nav.inbox": state.goInbox(); return true;
        case "nav.unreads": state.goInbox("unreads"); return true;
        case "nav.threads": state.goInbox("threads"); return true;
        case "settings": state.openPanel("settings"); return true;
        case "ui.sidebar": state.toggleSide(); return true;
        case "thread.expand": if (state.threadRoot == null) return false; state.toggleThreadSize(); return true;
        case "thread.close": if (state.threadRoot == null) return false; state.closeThread(); return true;
        case "agents.picker": {
          const openKey = useAddressing.getState().pickerKey;
          if (openKey) { useAddressing.getState().setPickerKey(null); focusComposer(openKey); return true; }
          if (!key) return false;
          const button = [...document.querySelectorAll<HTMLElement>(".ago-addr-btn[data-draft-key]")]
            .find(el => el.dataset.draftKey === key && el.getClientRects().length > 0);
          if (!button) return false;
          useAddressing.getState().setPickerKey(key);
          return true;
        }
        case "thread.requireMention": if (!key?.startsWith("t:")) return false; commandComposer(id, key); return true;
        case "voice.toggle": if (!key || !me?.voice_stt) return false; commandComposer(id, key); return true;
        case "voice.send": {
          const recordingKey = useVoiceRec.getState().recordingKey;
          const composer = [...document.querySelectorAll<HTMLElement>(".chat-input[data-draft-key]")]
            .find(el => el.dataset.draftKey === recordingKey && el.querySelector(".ago-mic"));
          if (!recordingKey || !composer) return false;
          commandComposer(id, recordingKey);
          return true;
        }
        case "voice.cancel": if (!useVoiceRec.getState().recordingKey) return false; voiceCancel(); return true;
        case "read.markChannel": if (state.view.kind !== "channel" || !state.sel.c || state.sel.c !== channelId || state.threadRoot != null) return false; markRead.mutate(null); return true;
        case "read.markAll": if (!unreads.data?.length) return false; markAll.mutate(unreads.data); return true;
        case "link.copy":
          if (!state.sel.g || !state.sel.c || state.view.kind !== "channel") return false;
          if (groups.some(g => g.channels.some(c => c.id === state.sel.c && c.kind === "agent_dm"))) return false;
          void copyDeepLink(state.threadRoot != null
            ? { kind: "thread", groupId: state.sel.g, channelId: state.sel.c, threadId: state.threadRoot }
            : { kind: "channel", groupId: state.sel.g, channelId: state.sel.c }, state.threadRoot != null ? "Thread" : "Channel");
          return true;
        case "focus.composer": return focusComposer();
        case "nav.back": return navigateAgoraHistory("back");
        case "nav.forward": return navigateAgoraHistory("forward");
      }
      if (id.startsWith("inbox.filter")) {
        if (state.view.kind !== "inbox" || state.inboxTab !== "unreads") return false;
        state.setInboxFilter((["all", "mentions", "channels", "threads"] as const)[Number(id.at(-1)) - 1]); return true;
      }
      if (id === "nav.prevChannel" || id === "nav.nextChannel") {
        const channels = [...document.querySelectorAll<HTMLElement>(".agora-side .ago-chan[data-channel-id]")]
          .map(row => ({ id: row.dataset.channelId!, group_id: row.dataset.groupId! }));
        if (!channels.length) return false;
        const at = channels.findIndex(c => c.id === state.sel.c);
        const direction = id === "nav.nextChannel" ? 1 : -1;
        const next = channels[at < 0 ? (direction === 1 ? 0 : channels.length - 1) : (at + direction + channels.length) % channels.length];
        state.selectChannel(next.group_id, next.id); return true;
      }
      if (id === "nav.prevUnread" || id === "nav.nextUnread") {
        const items = unreads.data ?? [];
        const at = nextUnreadIndex(items, { channelId: state.sel.c, threadId: state.threadRoot }, id === "nav.nextUnread" ? 1 : -1);
        if (at < 0) return false;
        const row = items[at]; state.selectChannel(row.group_id, row.channel_id);
        if (row.thread_id != null) state.openThread(row.thread_id);
        return true;
      }
      return false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key === "Dead") return;
      if (editing(event.target)) { clear(); shortcutMode = false; }
      if (event.repeat && !(event.altKey && event.key.startsWith("Arrow"))) return;
      if (editing(event.target)) {
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key !== "Escape") return;
      }
      const { me } = latest.current;
      const typing = editing(event.target);
      const overlay = overlayOpen();
      const pickerOnly = !!useAddressing.getState().pickerKey && !overlayOpen(true);
      const recording = !!useVoiceRec.getState().recordingKey;
      const state = useUiState.getState();
      const focused = document.activeElement as HTMLElement | null;
      const activeThread = state.threadRoot != null && (!!focused?.closest(".agora-thread") || (focused === document.body && lastPointerZone === "thread"));
      const allowedOverlay = (id: string) => id === "help.sheet" || id === "search" || (id === "agents.picker" && pickerOnly);
      const canType = !overlay && !typing && typeTarget(event.target) && !!composerKey() &&
        !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1 && event.key !== " ";
      if (!overlay && isDesktopShell() && matchesCombo("Mod+Comma", event, platform)) {
        event.preventDefault(); run("settings"); return;
      }
      if (sequence) {
        const prefix = pendingText;
        const forward = canForward();
        const next = !overlay && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
          ? nextSequence(sequence, event.key) : null;
        clear();
        const match = SHORTCUTS.find(s => s.sequence === next);
        if (match) { event.preventDefault(); run(match.id); return; }
        if (forward && canType && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) {
          if (typeIntoComposer(prefix + event.key)) { event.preventDefault(); return; }
        }
        if (forward && typeIntoComposer(prefix) && event.key === "Escape") { event.preventDefault(); return; }
      }
      const sequenceMode = shortcutMode || !typeTarget(event.target) || !composerKey();
      if (!overlay && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "?" && sequenceMode) {
        event.preventDefault(); run("help.sheet"); return;
      }
      if (!overlay && !typing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toUpperCase() === "G" && sequenceMode) {
        sequence = "G";
        pendingText = event.key;
        startedFromTypeTarget = typeTarget(event.target) && !!composerKey();
        startTarget = event.target instanceof HTMLElement ? event.target : null;
        startChannel = state.sel.c;
        startThread = state.threadRoot;
        startView = state.view.kind;
        timer = setTimeout(() => { const text = pendingText; const forward = canForward(); clear(); if (forward) typeIntoComposer(text); }, 1000);
        event.preventDefault(); return;
      }
      for (const shortcut of SHORTCUTS) {
        if (overlay && !allowedOverlay(shortcut.id)) continue;
        if (shortcut.feature === "voice_stt" && !me?.voice_stt) continue;
        if (shortcut.scope === "notTyping" && typing) continue;
        if (shortcut.scope === "inbox" && (typing || state.view.kind !== "inbox")) continue;
        if (shortcut.scope === "composer" && !composerKey()) continue;
        if (shortcut.scope === "thread" && state.threadRoot == null) continue;
        if (shortcut.scope === "recording" && !recording) continue;
        if (shortcut.id === "voice.cancel" && typing &&
          (event.target as HTMLElement).id !== (useVoiceRec.getState().recordingKey?.startsWith("t:") ? "ago-thread-msg" : "ago-msg")) continue;
        if (shortcut.desktopOnly && !isDesktopShell()) continue;
        if ((shortcut.id === "read.markChannel" || shortcut.id === "read.markAll") && (recording || state.threadRoot != null)) continue;
        if (shortcut.id === "focus.composer" && (!typeTarget(event.target) || overlay)) continue;
        if (shortcut.id === "thread.close" && (!activeThread || typing)) continue;
        const combo = bindingFor(shortcut.id, platform);
        if (matchesCombo(combo, event, platform)) {
          if ((shortcut.id === "nav.back" || shortcut.id === "nav.forward") && !isDesktopShell()) continue;
          if (run(shortcut.id)) { event.preventDefault(); clear(); return; }
          continue;
        }
      }
      if (canType) {
        const target = event.target as HTMLElement;
        const zone = target.closest("#ago-thread-log") ? "thread" : target.closest("#ago-log") ? "channel" : lastPointerZone;
        const key = zone === "thread" && state.threadRoot != null ? `t:${state.threadRoot}`
          : zone === "channel" ? `c:${state.sel.c}` : composerKey();
        if (typeIntoComposer(event.key, key)) event.preventDefault();
      }
    };
    const nativeCommand = (id: string) => { run(id); };
    const pointer = (event: PointerEvent) => {
      clear();
      shortcutMode = false;
      const target = event.target as HTMLElement;
      lastPointerZone = target.closest(".agora-thread") ? "thread" : target.closest("#ago-log") ? "channel" : null;
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (editing(target)) shortcutMode = false;
      if (target?.id === "ago-msg") { lastComposerKey = `c:${useUiState.getState().sel.c}`; lastPointerZone = "channel"; }
      if (target?.id === "ago-thread-msg") { lastComposerKey = `t:${useUiState.getState().threadRoot}`; lastPointerZone = "thread"; }
      if (target?.matches(".agora-main")) lastPointerZone = "channel";
      if (target?.matches(".agora-thread")) lastPointerZone = "thread";
    };
    (window as Window & { __agoraShortcut?: (id: string) => void }).__agoraShortcut = nativeCommand;
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus);
    const unsubscribe = useUiState.subscribe((next, previous) => {
      if (next.sel.c !== previous.sel.c || next.threadRoot !== previous.threadRoot || next.view.kind !== previous.view.kind) clear();
    });
    return () => { clear(); unsubscribe(); document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("focusin", focus); delete (window as Window & { __agoraShortcut?: (id: string) => void }).__agoraShortcut; };
  }, []);
}
