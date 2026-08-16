/* Voice-note upload — mobile-only (the web app has its own recorder), kept
   out of @agora/core. The hook body is the pre-adoption useSendVoice from
   the old src/api/queries.ts, rebuilt on the core package's client/cache
   plumbing. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { File as FSFile } from "expo-file-system";
import {
  appendMessage, applyMessageToGroups, keys, useApi,
  type Group, type Message, type MessagePages,
} from "@agora/core";

/** A picked/recorded file as the device hands it to us. Composer keeps this
    shape for previews; the upload boundary wraps the uri into a Blob part
    (expo-file-system's File carries the filename the server needs). */
export interface LocalFile {
  uri: string;
  name: string;
  type: string;
  size?: number;
}

export function toOutgoing(f: LocalFile): { part: Blob; name: string } {
  return { part: new FSFile(f.uri) as unknown as Blob, name: f.name };
}

function clientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** Voice note / live-voice turn: upload a recording, the server transcribes
    it and posts the transcript as a normal user message (returned here).
    `live` steers member agents to answer in spoken prose. `mentions` is the
    composer's "talk to" prefix ("@a, @b") — the server prepends it to the
    transcript so voice turns address agents like typed messages do. */
export function useSendVoice(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      file: LocalFile;
      threadId: number | null;
      live?: boolean;
      mentions?: string;
      /** Thread sticky: close the agent floor unless someone is @mentioned.
          Hub drops it when `live` is true. */
      requireAgent?: boolean;
    }) => {
      const form = new FormData();
      const out = toOutgoing(v.file);
      form.append("file", out.part, out.name);
      if (v.threadId != null) form.append("thread_id", String(v.threadId));
      if (v.live) form.append("live", "true");
      if (v.mentions) form.append("mentions", v.mentions);
      const tz = clientTimezone();
      if (tz) form.append("timezone", tz);
      if (v.requireAgent && v.threadId != null && !v.live) {
        form.append("require_agent", "true");
      }
      return api.upload<Message>(`/api/channels/${channelId}/voice`, form);
    },
    onSuccess: (message, v) => {
      qc.setQueryData<MessagePages>(
        keys.messages(channelId, v.threadId),
        (data) => appendMessage(data, message),
      );
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyMessageToGroups(groups, message, message.author_id),
      );
    },
  });
}
