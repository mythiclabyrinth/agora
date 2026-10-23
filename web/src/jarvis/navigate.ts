/* In-app navigation for the assistant: its cards' "Open" buttons and the
   conversations it opens when asked. */

import { useJump } from "../state/jump";
import { useUiState } from "../state/ui";

export interface JarvisTarget {
  group_id: string;
  channel_id: string;
  thread_id?: number | null;
  message_id?: number;
}

/** Show a channel, thread, or message. Selecting the channel closes any
    open thread first, so "open #release" leaves the thread you were in. */
export function jumpTo(target: JarvisTarget): void {
  const ui = useUiState.getState();
  ui.selectChannel(target.group_id, target.channel_id);
  if (target.thread_id != null) {
    ui.openThread(target.thread_id, "replace");
    if (target.message_id != null) useJump.getState().request({ mid: target.message_id, container: "thread" });
  } else if (target.message_id != null) {
    useJump.getState().request({ mid: target.message_id, container: "log" });
  }
}
