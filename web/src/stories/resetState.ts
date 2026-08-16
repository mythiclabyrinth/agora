import { useAttachmentDrafts, useLive, useTldrView } from "@agora/core";
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

const STORAGE_KEYS = [
  "agora_token",
  "agora_sel",
  "agora_open",
  "agora_chan_collapsed",
  "agora_unreads_only",
  "agora_side",
  "agora_thread",
  "agora_speak",
  "agora_thread_require_agent",
  "agoEmojiRecent",
];

/* The preview's own URL, captured before any story play rewrites history.
   Resetting to "/" would strip a GitHub Pages project base such as /agora/
   that the fixture-file shim and Storybook itself derive from the URL. */
const HOME = new URL(".", window.location.href).pathname;

/** Reset module-scoped zustand stores as well as their persisted inputs. */
export function resetStoryState(): void {
  history.replaceState(null, "", HOME + window.location.search);
  for (const key of STORAGE_KEYS) localStorage.removeItem(key);
  useUiState.setState({
    sel: {},
    view: { kind: "channel" },
    mobileView: "side",
    panel: null,
    expanded: null,
    collapsedChannels: [],
    unreadsOnly: false,
    hiddenOpen: false,
    sideCollapsed: false,
    threadRoot: null,
    threadExpanded: false,
    membersOpen: false,
    searchOpen: false,
  });
  useConfirm.getState().disarm();
  useJump.getState().clear();
  useDrafts.setState({ drafts: {} });
  useAddressing.setState({ addr: {} });
  useAttachmentDrafts.getState().reset();
  useLive.setState({ typing: {}, progress: {} });
  useTldrView.setState({ showing: {} });
  useEmojiPicker.getState().close();
  useSourcesView.getState().close();
  useAgentProfile.getState().close();
  useVoiceRec.setState({ recordingKey: null, startedAt: 0, busyKey: null });
  useLiveVoice.setState({ scope: null, state: "listening", muted: false });
  useSpeak.setState({ on: false });
  useRequireAgent.getState().resetAll();
  useToasts.setState({ toasts: [] });
}
