/* The chat layout (.agora-layout): sidebar + main pane + thread pane +
   members pane, with the same layout-state classes the CSS keys off
   (view-*, side-collapsed, thread-expanded). Mounts the live socket and
   defaults the selection to the first visible group/channel like
   agoLoadGroups. */

import { useEffect, useRef, useState } from "react";
import { parseDeepLink, useGroups, useMe } from "@agora/core";
import { useAgoraSocket } from "../hooks/useAgoraSocket";
import { useUiState } from "../state/ui";
import { Sidebar } from "./Sidebar";
import { ChannelPane } from "./ChannelPane";
import { ThreadsInbox } from "./ThreadsInbox";
import { ThreadPane } from "./ThreadPane";
import { GroupOverview } from "./GroupOverview";
import { MembersPanel } from "./MembersPanel";
import { AttachmentBrowser } from "./AttachmentBrowser";
import { SearchPane } from "./SearchPane";
import { PeoplePane } from "./PeoplePane";
import { ConnectionsPane } from "./ConnectionsPane";
import { SourcesViewer } from "./SourcesViewer";
import { AgentProfileCard } from "./AgentProfileCard";
import { EmojiPickerHost } from "./EmojiPicker";
import { useToggleReactionById } from "../hooks/useToggleReactionById";
import { liveOnAgentMessage, useLiveVoice } from "../state/liveVoice";
import { speakEnqueue, useSpeak } from "../state/speak";
import { useJump } from "../state/jump";

export function AgoraLayout() {
  const me = useMe().data;
  const groups = useGroups().data;
  const ui = useUiState();
  const requestJump = useJump(s => s.request);
  const [locationKey, setLocationKey] = useState(0);
  const resolvedLocation = useRef<string | null>(null);
  useAgoraSocket(me?.username || "", (m) => {
    // Live voice: an agent reply in the session's scope closes the turn and
    // gets spoken; the 🔊 toggle reads out other agent replies unless a live
    // session already speaks for the selected channel (agoIngestMessage).
    liveOnAgentMessage(m);
    const scope = useLiveVoice.getState().scope;
    const liveHere = !!scope && scope.channelId === useUiState.getState().sel.c;
    if (useSpeak.getState().on && !liveHere) speakEnqueue(m.id);
  });
  const toggleReaction = useToggleReactionById();

  useEffect(() => {
    const onPop = () => setLocationKey(k => k + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Resolve the URL only after visibility-scoped groups have loaded. A URL
  // always wins over the remembered selection; invalid/inaccessible targets
  // fall through to the ordinary first-visible selection.
  useEffect(() => {
    if (!groups || !groups.length) return;
    const location = `${locationKey}:${window.location.pathname}`;
    if (window.location.pathname === "/threads") {
      if (ui.view.kind !== "inbox" || ui.threadRoot != null) {
        resolvedLocation.current = location;
        ui.openInbox("none");
      }
      return;
    }
    const target = parseDeepLink(window.location.pathname);
    if (target) {
      const group = groups.find(g => g.id === target.groupId);
      if (group) {
        if (target.kind === "group") {
          if (ui.view.kind !== "group" || ui.sel.g !== group.id || ui.threadRoot != null) {
            ui.openGroupPage(group.id, "none");
          }
          resolvedLocation.current = location;
          return;
        }
        const channel = (group.channels || []).find(c => c.id === target.channelId);
        if (channel) {
          const channelSelected =
            ui.view.kind === "channel" &&
            ui.sel.g === group.id &&
            ui.sel.c === channel.id;
          const expectedThread =
            target.kind === "thread" ? target.threadId
              : target.kind === "message" ? target.threadId : null;
          const scopeSelected =
            channelSelected && ui.threadRoot === (expectedThread ?? null);

          // pushState does not emit popstate. In-app navigation already put
          // the UI in this scope, so treat it as resolved without resetting
          // narrow-screen drill-down state on the next groups cache update.
          if (scopeSelected && target.kind !== "message") {
            resolvedLocation.current = location;
            return;
          }
          if (scopeSelected && resolvedLocation.current === location) return;
          if (scopeSelected && target.kind === "message") {
            resolvedLocation.current = location;
            requestJump({
              mid: target.messageId,
              container: target.threadId == null ? "log" : "thread",
            });
            return;
          }

          ui.selectChannel(group.id, channel.id, "none");
          if (target.kind === "thread") {
            ui.openThread(target.threadId, "none");
          } else if (target.kind === "message" && target.threadId != null) {
            ui.openThread(target.threadId, "none");
          }
          if (target.kind === "message") {
            requestJump({
              mid: target.messageId,
              container: target.threadId == null ? "log" : "thread",
            });
          }
          resolvedLocation.current = location;
          return;
        }
      }
    }
    const selGroup = groups.find(g => g.id === ui.sel.g);
    if (!selGroup) {
      const first = groups.find(g => !g.hidden) || groups[0];
      if (first) {
        const chan = (first.channels || []).find(c => !c.hidden) || (first.channels || [])[0];
        if (chan) ui.selectChannel(first.id, chan.id, "replace");
      }
      return;
    }
    const selChan = (selGroup.channels || []).find(c => c.id === ui.sel.c);
    if (!selChan && ui.view.kind === "channel") {
      const chan = (selGroup.channels || []).find(c => !c.hidden) || (selGroup.channels || [])[0];
      if (chan) ui.selectChannel(selGroup.id, chan.id, "replace");
      return;
    }
    // Normalize the legacy/root entry even when localStorage already points
    // at a valid selection; otherwise Back can land on an inert "/" URL.
    if ((window.location.pathname === "/" || target) && selChan) {
      if (ui.view.kind === "group") ui.openGroupPage(selGroup.id, "replace");
      else if (ui.view.kind === "inbox") ui.openInbox("replace");
      else ui.selectChannel(selGroup.id, selChan.id, "replace");
    }
  }, [groups, locationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewClass = `view-${ui.mobileView}`;

  return (
    <div id="content">
      <div
        className={`agora-layout ${viewClass}${ui.sideCollapsed ? " side-collapsed" : ""}${ui.threadRoot != null && ui.threadExpanded ? " thread-expanded" : ""}`}
        id="agora-layout">
        <Sidebar />
        {ui.view.kind === "channel" && <ChannelPane />}
        {ui.view.kind === "inbox" && <ThreadsInbox />}
        {ui.view.kind === "group" && <GroupOverview />}
        {ui.threadRoot != null
          ? <ThreadPane />
          : <div className="agora-thread" id="agora-thread" style={{ display: "none" }}></div>}
        <MembersPanel />
        <AttachmentBrowser />
      </div>
      <EmojiPickerHost onPick={(mid, emoji) => toggleReaction(mid, emoji)} />
      <SearchPane />
      <PeoplePane />
      <ConnectionsPane />
      <SourcesViewer />
      <AgentProfileCard />
    </div>
  );
}
