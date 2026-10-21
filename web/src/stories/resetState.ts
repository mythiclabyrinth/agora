import { draftSync, useAddressed, useAttachmentDrafts, useLive, useTldrView } from "@agora/core";
import { useAddressing, useDrafts } from "../components/Composer";
import { useEmojiPicker } from "../components/EmojiPicker";
import { useAgentProfile, useSourcesView } from "../components/MessageItem";
import { useConfirm } from "../state/confirm";
import { useJump } from "../state/jump";
import { useUiState } from "../state/ui";
import { useVoiceRec } from "../state/voiceRec";
import { useLiveVoice } from "../state/liveVoice";
import { useSpeak } from "../state/speak";
import { useRequireAgent } from "../state/requireAgent";
import { useToasts } from "../lib/toast";
import { useAppearance } from "../state/appearance";
import { useShortcutState } from "../state/shortcuts";
import { useJarvis } from "../state/jarvis";

const STORAGE_KEYS = [
  "agora_token",
  "agora_sel",
  "agora_open",
  "agora_chan_collapsed",
  "agora_unreads_only",
  "agora_sound_enabled",
  "agora_sound_volume",
  "agora_threads_sort",
  "agora_threads_filter",
  "agora_threads_group",
  "agora_shortcuts",
  "agora_side",
  "agora_thread",
  "agora_thread_width",
  "agora_speak",
  "agora_thread_require_agent",
  "agoEmojiRecent",
  "agora_jarvis_enabled",
  "agora_jarvis_mic_muted",
  "agora_jarvis_speaker_off",
];

/* The preview's own URL, captured before any story play rewrites history.
   Resetting to "/" would strip a GitHub Pages project base such as /agora/
   that the fixture-file shim and Storybook itself derive from the URL. */
const HOME = new URL(".", window.location.href).pathname;

/** Reset module-scoped zustand stores as well as their persisted inputs. */
export function resetStoryState(): void {
  delete (window as Window & { __AGORA_DESKTOP__?: boolean }).__AGORA_DESKTOP__;
  useAppearance.getState().setPreference(import.meta.env.VITE_STORY_THEME === "light" ? "light" : "dark");
  history.replaceState(null, "", HOME + window.location.search);
  for (const key of STORAGE_KEYS) localStorage.removeItem(key);
  useUiState.setState({
    sel: {},
    view: { kind: "channel" },
    mobileView: "side",
    panel: null,
    settingsTab: "appearance",
    expanded: null,
    collapsedChannels: [],
    unreadsOnly: false,
    soundEnabled: true,
    soundVolume: 70,
    threadsSort: "recent",
    threadsFilter: "all",
    threadsGroup: null,
    inboxTab: "unreads",
    inboxFilter: "all",
    hiddenOpen: false,
    sideCollapsed: false,
    threadRoot: null,
    threadExpanded: false,
    membersOpen: false,
    searchOpen: false,
  });
  useConfirm.getState().disarm();
  useJump.getState().clear();
  draftSync.resetAll();
  useDrafts.getState().resetAll();
  useAddressed.getState().resetAll();
  useAddressing.setState({ pickerKey: null });
  useShortcutState.setState({ bindings: {}, sheetOpen: false });
  useAttachmentDrafts.getState().reset();
  useLive.setState({ typing: {}, progress: {}, epoch: 0, touched: {} });
  useTldrView.setState({ showing: {} });
  useEmojiPicker.getState().close();
  useSourcesView.getState().close();
  useAgentProfile.getState().close();
  useVoiceRec.setState({ recordingKey: null, startedAt: 0, busyKey: null });
  useLiveVoice.setState({ scope: null, state: "listening", muted: false });
  useSpeak.setState({ on: false });
  useJarvis.setState({
    enabled: false, isOpen: false, phase: "idle", label: "", transcript: "", caption: "", cards: [],
    conversationId: null, error: null, busy: false, pendingAsk: null, wake: "off", wakeError: null,
    log: [], spoken: null, micMuted: false, speakerOff: false, listenSeq: 0, micOwned: false,
  });
  useRequireAgent.getState().resetAll();
  useToasts.setState({ toasts: [] });
}
