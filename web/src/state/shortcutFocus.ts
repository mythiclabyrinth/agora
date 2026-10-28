import { useEmojiPicker } from "../components/EmojiPicker";
import { hasOpenDialog } from "../hooks/useDialogFocus";
import { useShortcutState } from "./shortcuts";
import { useUiState } from "./ui";

export type ComposerZone = "thread" | "channel";

let shortcutMode = false;
let pointerZone: ComposerZone | null = null;
let channelReadArmed = false;

export const isShortcutMode = () => shortcutMode;
export const setShortcutMode = (enabled: boolean) => { shortcutMode = enabled; };
export const getPointerZone = () => pointerZone;
export const setPointerZone = (zone: ComposerZone | null) => { pointerZone = zone; };
export const isChannelReadArmed = () => channelReadArmed;
export const clearChannelReadArm = () => { channelReadArmed = false; };
export function leaveComposerForShortcuts(zone: ComposerZone) {
  pointerZone = zone;
  shortcutMode = true;
  channelReadArmed = zone === "channel";
}

export function overlayOpen(pickerOpen = false, ignorePicker = false): boolean {
  const ui = useUiState.getState();
  let popoverOpen = false;
  try { popoverOpen = !!document.querySelector("[popover]:popover-open"); } catch { /* older WebKit */ }
  return hasOpenDialog() || !!ui.panel || ui.searchOpen || useShortcutState.getState().sheetOpen ||
    (!ignorePicker && pickerOpen) || useEmojiPicker.getState().openFor != null ||
    popoverOpen || !!document.querySelector(".ago-image-lightbox, .ago-pin-pop, .tools-open, .ago-dm-popover, .ago-react-pop, .thread-resizing, #ago-sources-overlay, .ago-template-pop, [role='dialog']");
}
