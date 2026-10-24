/* The ⋯ sheet actions for the channel and thread headers. Built here, not
   inline in the screens, so both lists stay in step (attachments → schedules
   → the rest) and can be tested without mounting a whole conversation. */

import { router } from "expo-router";
import { CalendarClock, Paperclip, Pin, Star, Users, Volume2 } from "lucide-react-native";
import type { ConversationTool } from "../components/ConversationTools";

type Where = { channelId: string; channelName?: string | null; groupId?: string | null };
type Speech = { ttsOk: boolean; speakAloud: boolean; toggleSpeak: () => void };

function readAloud({ ttsOk, speakAloud, toggleSpeak }: Speech): ConversationTool[] {
  return ttsOk ? [{ label: "Read replies aloud", detail: speakAloud ? "On · tap to turn off" : "Off · tap to turn on",
    icon: Volume2, selected: speakAloud, onPress: toggleSpeak }] : [];
}

export function channelToolActions(where: Where & Speech & {
  stars: boolean; showMembers: boolean; onPins: () => void; onStars: () => void; onMembers: () => void;
}): ConversationTool[] {
  const params = { channelId: where.channelId, channelName: where.channelName ?? undefined, groupId: where.groupId ?? undefined };
  return [
    { label: "Channel attachments", detail: "Files, images and shared media", icon: Paperclip,
      onPress: () => router.push({ pathname: "/(app)/attachments/[channelId]", params }) },
    { label: "Schedules", detail: "Messages set to post later", icon: CalendarClock,
      onPress: () => router.push({ pathname: "/(app)/schedules/[channelId]", params }) },
    { label: "Pinned messages", detail: "The things worth keeping close", icon: Pin, onPress: where.onPins },
    ...(where.stars ? [{ label: "Starred messages", icon: Star, onPress: where.onStars }] : []),
    ...(where.showMembers ? [{ label: "Participants", detail: "People, agents and channel access", icon: Users, onPress: where.onMembers }] : []),
    ...readAloud(where),
  ];
}

export function threadToolActions(where: Where & Speech & { rootId: number; threadName?: string }): ConversationTool[] {
  const params = { channelId: where.channelId, channelName: where.channelName ?? undefined, groupId: where.groupId ?? undefined,
    threadId: String(where.rootId), threadName: where.threadName };
  return [
    { label: "Thread attachments", detail: "Files, images and shared media", icon: Paperclip,
      onPress: () => router.push({ pathname: "/(app)/attachments/[channelId]", params }) },
    { label: "Schedules", detail: "Messages set to post later in this thread", icon: CalendarClock,
      onPress: () => router.push({ pathname: "/(app)/schedules/[channelId]", params }) },
    ...readAloud(where),
  ];
}
