import { expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { cacheSentMessage } from "../src/api/queries";
import { keys } from "../src/api/keys";
import type { Message } from "../src/api/types";
import type { MessagePages } from "../src/ws/reducer";

it("keeps a send response's draft outcome out of the message cache", () => {
  const qc = new QueryClient();
  const response = {
    id: 12, channel_id: "general", text: "sent", ts: 1, author_id: "ana",
    author_name: "Ana", author_type: "user", thread_id: null, reply_count: 0, attachments: [],
    draft: { deleted: false, row: { channel_id: "general", thread_id: null,
      body: "someone else's private draft", meta: { addressed: [], reply_in_thread: false },
      rev: 2, client_id: "phone", updated_at: 1 } },
  } satisfies Message;
  qc.setQueryData<MessagePages>(keys.messages("general", null), { pages: [[]], pageParams: [undefined] });
  cacheSentMessage(qc, "general", null, response);
  const cached = qc.getQueryData<MessagePages>(keys.messages("general", null))?.pages[0][0];
  expect(cached?.text).toBe("sent");
  expect(cached).not.toHaveProperty("draft");
  expect(response.draft?.row?.body).toBe("someone else's private draft");
  qc.clear();
});
