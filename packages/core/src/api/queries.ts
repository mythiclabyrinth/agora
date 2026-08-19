/* TanStack Query hooks for the whole REST surface. Live updates arrive via
   the WS reducer; these hooks own initial fetches, pagination and writes. */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { keys } from "./keys";
import { memberRemovalPath, resolveMemberGroupId } from "./memberPaths";
import { useApi } from "./context";
import { useLive } from "../state/live";
import {
  appendMessage,
  applyMessageDelete,
  applyMessageUpdate,
  applyMessageToGroups,
  replaceMessage,
  type MessagePages,
} from "../ws/reducer";
import type {
  AgentInfo,
  AgentDmList,
  AgentDmPolicy,
  AgentSource,
  AttachmentPage,
  AskResponse,
  Channel,
  ChannelActivity,
  ChannelAgent,
  Connection,
  Group,
  InstanceInfo,
  InstanceAiSettings,
  InstanceAiUpdate,
  InstanceMembership,
  Invite,
  InviteLink,
  Me,
  Member,
  Message,
  MessageTemplate,
  PairingToken,
  PinnedMessage,
  SearchResponse,
  StarredMessage,
  ThreadRow,
  UserInfo,
} from "./types";

const PAGE_SIZE = 50;

/* ------------------------------------------------------- message templates */

export function useTemplates(groupId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.templates(groupId),
    queryFn: async () => (await api.get<{ templates: MessageTemplate[] }>(
      `/api/groups/${encodeURIComponent(groupId)}/templates`,
    )).templates,
    enabled: !!groupId,
    staleTime: 60_000,
  });
}

export function useCreateTemplate(groupId: string) {
  const api = useApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { label: string; text: string }) => api.post<MessageTemplate>(
      `/api/groups/${encodeURIComponent(groupId)}/templates`, v,
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.templates(groupId) }),
  });
}

export function useUpdateTemplate(groupId: string) {
  const api = useApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; label: string; text: string }) => api.patch<MessageTemplate>(
      `/api/groups/${encodeURIComponent(groupId)}/templates/${encodeURIComponent(v.id)}`, v,
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.templates(groupId) }),
  });
}

export function useDeleteTemplate(groupId: string) {
  const api = useApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(
      `/api/groups/${encodeURIComponent(groupId)}/templates/${encodeURIComponent(id)}`,
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.templates(groupId) }),
  });
}

/* ------------------------------------------------------------- me */

/** Server capabilities (`voice`, `search_ai`) + identity. Rarely changes
    within a session, so cache it for a long while. */
export function useMe() {
  const api = useApi();
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<Me>("/api/me"),
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------------------------------------- groups */

export function useGroups() {
  const api = useApi();
  return useQuery({
    queryKey: keys.groups,
    queryFn: async () => (await api.get<{ groups: Group[] }>("/api/groups")).groups,
  });
}

export function useCreateGroup() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; description?: string }) =>
      api.post<Group>("/api/groups", v),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

export function useDeleteGroup() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => api.delete(`/api/groups/${groupId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

/** Hide (or show) a group in the home list — presentation only. */
export function useSetGroupHidden() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; hidden: boolean }) =>
      api.patch(`/api/groups/${v.groupId}`, { hidden: v.hidden }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

/** Open a group to every signed-in user, or make it members-only again.
    Group-admin gated server-side — it changes access, not presentation. */
export function useSetGroupPublic() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; isPublic: boolean }) =>
      api.patch(`/api/groups/${v.groupId}`, { is_public: v.isPublic }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

export function useCreateChannel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; name: string; topic?: string }) =>
      api.post(`/api/groups/${v.groupId}/channels`, { name: v.name, topic: v.topic }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

export function useUpdateChannel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      groupId: string;
      channelId: string;
      name?: string;
      topic?: string;
      hidden?: boolean;
    }) =>
      api.patch(`/api/groups/${v.groupId}/channels/${v.channelId}`, {
        name: v.name,
        topic: v.topic,
        hidden: v.hidden,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.groups });
      void qc.invalidateQueries({ queryKey: keys.threads });
    },
  });
}

/** Persist a drag-reorder of the home group list. */
export function useReorderGroups() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.put("/api/groups/order", { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

/** Persist a drag-reorder of one group's channel list. */
export function useReorderChannels() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; ids: string[] }) =>
      api.put(`/api/groups/${encodeURIComponent(v.groupId)}/channels/order`, { ids: v.ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

export function useDeleteChannel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; channelId: string }) =>
      api.delete(`/api/groups/${v.groupId}/channels/${v.channelId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

/* ------------------------------------------------------------- members */

/** Workspace accounts — feeds the members screen's add-person picker. */
export function useUsers(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.users,
    queryFn: async () => (await api.get<{ users: UserInfo[] }>("/api/users")).users,
    staleTime: 60_000,
    enabled,
  });
}

export function useMembers(groupId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.members(groupId),
    queryFn: async () =>
      (await api.get<{ members: Member[] }>(`/api/groups/${groupId}/members`)).members,
    enabled: !!groupId,
  });
}

export function useAllMemberships(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.memberships,
    queryFn: async () => (await api.get<{ memberships: InstanceMembership[] }>("/api/memberships")).memberships,
    enabled,
  });
}

export function useAddMember(groupId?: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      group_id?: string;
      member_type: "user" | "agent";
      member_id: string;
      role?: string;
      channel_id?: string;
    }) => {
      const targetGroupId = resolveMemberGroupId(groupId, v.group_id);
      const { group_id: _groupId, ...body } = v;
      return api.post(`/api/groups/${targetGroupId}/members`, body);
    },
    onSuccess: (_data, v) => {
      const targetGroupId = v.group_id ?? groupId;
      if (targetGroupId) void qc.invalidateQueries({ queryKey: keys.members(targetGroupId) });
      void qc.invalidateQueries({ queryKey: keys.memberships });
      void qc.invalidateQueries({ queryKey: keys.groups });
      // Mention chips + "no agents" banners key off the per-channel agent list.
      void qc.invalidateQueries({ queryKey: ["channelAgents"] });
    },
  });
}

export function useRemoveMember(groupId?: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { group_id?: string; member_type: string; member_id: string; channel_id?: string | null; all_scopes?: boolean }) => {
      const targetGroupId = resolveMemberGroupId(groupId, v.group_id);
      return api.delete(memberRemovalPath({
        groupId: targetGroupId,
        memberType: v.member_type,
        memberId: v.member_id,
        channelId: v.channel_id,
        allScopes: v.all_scopes,
      }));
    },
    onSuccess: (_data, v) => {
      const targetGroupId = v.group_id ?? groupId;
      if (targetGroupId) void qc.invalidateQueries({ queryKey: keys.members(targetGroupId) });
      void qc.invalidateQueries({ queryKey: keys.memberships });
      void qc.invalidateQueries({ queryKey: keys.groups });
      void qc.invalidateQueries({ queryKey: ["channelAgents"] });
    },
  });
}

/* ------------------------------------------------------------- messages */

/** Pages of a channel's top level (threadId null) or one thread.
    pages[0] is the newest page; each page is newest-last (server order). */
export function useMessages(channelId: string, threadId: number | null) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.messages(channelId, threadId),
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (threadId != null) params.set("thread_id", String(threadId));
      if (pageParam) params.set("before_id", String(pageParam));
      const r = await api.get<{ messages: Message[] }>(
        `/api/channels/${channelId}/messages?${params}`,
      );
      return r.messages;
    },
    initialPageParam: undefined as number | undefined,
    // Older page cursor: the oldest id we have. A short page means we hit
    // the start of history.
    getNextPageParam: (lastPage) =>
      lastPage.length < PAGE_SIZE ? undefined : lastPage[0]?.id,
    enabled: !!channelId,
  });
}

/** Flatten pages into chronological (oldest-first) order. */
export function flattenMessages(data: MessagePages | undefined): Message[] {
  if (!data) return [];
  return [...data.pages].reverse().flat();
}

/** Platform-neutral multipart part. On web, `part` is a browser File (its
    filename rides along automatically). On RN, the host wraps a local uri
    into a Blob (e.g. expo-file-system's File) and supplies `name`. */
export interface OutgoingFile {
  part: Blob;
  name?: string;
}

function appendFile(form: FormData, field: string, f: OutgoingFile): void {
  if (f.name) form.append(field, f.part, f.name);
  else form.append(field, f.part);
}

/** Sender's IANA timezone, attached hidden to every outgoing message so
    agents can reason about the user's local time. Never rendered in chat. */
function clientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function useSendMessage(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      text: string;
      threadId: number | null;
      files?: OutgoingFile[];
      /** Cancels an attachment upload; text-only sends do not need one. */
      signal?: AbortSignal;
      /** Ask agents to answer in a thread under this (top-level) message. */
      replyInThread?: boolean;
      /** Thread sticky: close the agent floor unless someone is @mentioned. */
      requireAgent?: boolean;
    }) => {
      const tz = clientTimezone();
      const askThread = v.replyInThread === true && v.threadId == null;
      const requireAgent = v.requireAgent === true && v.threadId != null;
      if (v.files && v.files.length > 0) {
        const form = new FormData();
        form.append("text", v.text);
        if (v.threadId != null) form.append("thread_id", String(v.threadId));
        if (tz) form.append("timezone", tz);
        if (askThread) form.append("reply_in_thread", "true");
        if (requireAgent) form.append("require_agent", "true");
        for (const f of v.files) {
          appendFile(form, "files", f);
        }
        return api.upload<Message>(
          `/api/channels/${channelId}/messages/upload`,
          form,
          v.signal,
        );
      }
      return api.post<Message>(`/api/channels/${channelId}/messages`, {
        text: v.text,
        thread_id: v.threadId,
        ...(tz ? { timezone: tz } : {}),
        ...(askThread ? { reply_in_thread: true } : {}),
        ...(requireAgent ? { require_agent: true } : {}),
      });
    },
    onSuccess: (message, v) => {
      // The WS echo will dedupe against this append.
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

export function useSelectOption() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: number; optionId: string }) =>
      api.post<Message>(`/api/messages/${v.messageId}/select`, {
        option_id: v.optionId,
      }),
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Persist one field of a message's shared form state (a checkbox toggle or
    a confirmed input value). Fans out to every client as a message_update;
    the authoring agent hears nothing until a button is pressed. */
export function useUpdateFormState() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      messageId: number;
      fieldId: string;
      value: string | boolean;
    }) =>
      api.post<Message>(`/api/messages/${v.messageId}/form_state`, {
        field_id: v.fieldId,
        value: v.value,
      }),
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Press a form button: the server snapshots the shared state, locks the
    form one-shot (a raced second press gets a 409), and forwards the
    submission to the authoring agent. */
export function useSubmitForm() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: number; buttonId: string }) =>
      api.post<Message>(`/api/messages/${v.messageId}/form_submit`, {
        button_id: v.buttonId,
      }),
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Persist one confirmed cell edit on a message's shared table state. */
export function useUpdateTableCell() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      messageId: number;
      rowId: string;
      columnId: string;
      value: string | number;
    }) =>
      api.post<Message>(`/api/messages/${v.messageId}/table_cell`, {
        row_id: v.rowId,
        column_id: v.columnId,
        value: v.value,
      }),
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Press a per-row table action: locks that row one-shot and notifies the
    authoring agent with the row's current cell values. */
export function useActOnTableRow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      messageId: number;
      rowId: string;
      actionId: string;
    }) =>
      api.post<Message>(`/api/messages/${v.messageId}/table_action`, {
        row_id: v.rowId,
        action_id: v.actionId,
      }),
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Press a table-level button: snapshots still-unlocked rows, locks the
    table one-shot, and forwards the submission to the authoring agent. */
export function useSubmitTable() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: number; buttonId: string }) =>
      api.post<Message>(`/api/messages/${v.messageId}/table_submit`, {
        button_id: v.buttonId,
      }),
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Toggle the caller's emoji reaction on a message. The server returns the
    updated message, which is patched into the cache in place; the
    message_update broadcast then merges as a no-op. */
export function useToggleReaction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { message: Message; emoji: string; on: boolean }) => {
      const path =
        `/api/channels/${encodeURIComponent(v.message.channel_id)}` +
        `/messages/${v.message.id}/reactions/${encodeURIComponent(v.emoji)}`;
      return v.on ? api.put<Message>(path) : api.delete<Message>(path);
    },
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Delete a message — the sender's own, or any message for a group admin
    (the server enforces both). The message_delete broadcast scrubs caches
    for everyone else; applying it locally too makes the sheet's delete
    feel immediate. */
export function useDeleteMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { message: Message }) =>
      api.delete(
        `/api/channels/${encodeURIComponent(v.message.channel_id)}/messages/${v.message.id}`,
      ),
    onSuccess: (_res, v) =>
      applyMessageDelete(qc, {
        type: "message_delete",
        channel_id: v.message.channel_id,
        message_id: v.message.id,
        thread_id: v.message.thread_id,
      }),
  });
}

/* ------------------------------------------------------- attachment browser */

export function useAttachments(channelId: string, threadId: number | null) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.attachments(channelId, threadId),
    queryFn: ({ pageParam }) => api.get<AttachmentPage>(
      `/api/channels/${encodeURIComponent(channelId)}/attachments?offset=${pageParam}` +
      (threadId == null ? "" : `&thread_id=${threadId}`),
    ),
    initialPageParam: 0,
    getNextPageParam: page => page.has_more ? page.offset + page.items.length : undefined,
    enabled: !!channelId,
  });
}

export function useDeleteAttachment(channelId: string, threadId: number | null) {
  const api = useApi(); const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.delete<Message>(
      `/api/channels/${encodeURIComponent(channelId)}/attachments/${encodeURIComponent(fileId)}`,
    ),
    onSuccess: message => {
      applyMessageUpdate(qc, message);
      qc.invalidateQueries({ queryKey: keys.attachments(channelId, threadId) });
    },
  });
}

/** Edit the signed-in author's message. The server broadcasts the same
    message_update to other UI clients; applying it locally avoids latency. */
export function useEditMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { message: Message; text: string }) =>
      api.patch<Message>(
        `/api/channels/${encodeURIComponent(v.message.channel_id)}/messages/${v.message.id}`,
        { text: v.text },
      ),
    onSuccess: (message) => applyMessageUpdate(qc, message),
  });
}

export function useMarkRead(channelId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (lastReadId: number | null) =>
      api.put<{ ok: boolean; last_read_id: number }>(
        `/api/channels/${channelId}/read`,
        { last_read_id: lastReadId },
      ),
    // Groups cache is patched by the WS "read" echo.
  });
}

/* ------------------------------------------------------------- search */

/** Optional search scope: restrict message hits (and Ask-AI) to one channel
    or one whole group. Both unset = everywhere. */
export interface SearchScope {
  channelId?: string;
  groupId?: string;
}

/** Stable cache-key fragment for a scope, so switching filters re-fetches. */
function scopeKey(scope?: SearchScope): string {
  if (scope?.channelId) return `c:${scope.channelId}`;
  if (scope?.groupId) return `g:${scope.groupId}`;
  return "";
}

/** `&channel_id=…` / `&group_id=…` suffix for GET /api/search. */
function scopeQuery(scope?: SearchScope): string {
  let s = "";
  if (scope?.channelId) s += `&channel_id=${encodeURIComponent(scope.channelId)}`;
  if (scope?.groupId) s += `&group_id=${encodeURIComponent(scope.groupId)}`;
  return s;
}

/** Attachment filter: "" = any content, "any" = only messages with files, or
    one kind. An active filter lets the search run with an empty query
    (browse every message carrying a matching attachment). */
export type FileFilter = "" | "any" | "image" | "pdf" | "doc" | "video" | "audio";

/** `&has_files=1` / `&file_type=…` suffix for GET /api/search, "" when off. */
function fileQuery(file?: FileFilter): string {
  if (file === "any") return "&has_files=1";
  if (file) return `&file_type=${encodeURIComponent(file)}`;
  return "";
}

/** First page of GET /api/search for `q`. `keepPreviousData` holds the last
    results on screen while a retyped query is in flight. */
export function useSearch(q: string, scope?: SearchScope, file?: FileFilter) {
  const api = useApi();
  return useQuery({
    queryKey: keys.search(q, scopeKey(scope), file ?? ""),
    queryFn: () =>
      api.get<SearchResponse>(
        `/api/search?q=${encodeURIComponent(q)}${scopeQuery(scope)}${fileQuery(file)}`,
      ),
    // A file filter alone (empty query) is a valid "browse files" search.
    enabled: q.trim().length > 0 || !!file,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Imperative "More results" page fetch; the screen accumulates the pages
    in local state, so this is a mutation rather than a keyed query. */
export function useSearchMore() {
  const api = useApi();
  return useMutation({
    mutationFn: async (v: {
      q: string;
      offset: number;
      scope?: SearchScope;
      file?: FileFilter;
    }) =>
      (
        await api.get<SearchResponse>(
          `/api/search?q=${encodeURIComponent(v.q)}&offset=${v.offset}&types=messages${scopeQuery(v.scope)}${fileQuery(v.file)}`,
        )
      ).messages,
  });
}

/** POST /api/search/ask — AI answer with [n] citations into `sources`.
    Only offered when /api/me reports `search_ai`. */
export function useAskAi() {
  const api = useApi();
  return useMutation({
    mutationFn: (v: { q: string; scope?: SearchScope }) =>
      api.post<AskResponse>("/api/search/ask", {
        q: v.q,
        ...(v.scope?.channelId ? { channel_id: v.scope.channelId } : {}),
        ...(v.scope?.groupId ? { group_id: v.scope.groupId } : {}),
      }),
  });
}

/* ------------------------------------------------------------- threads */

/** The threads inbox: every thread the user participates in, newest first.
    Live updates arrive via the WS reducer. */
export function useThreads() {
  const api = useApi();
  return useQuery({
    queryKey: keys.threads,
    queryFn: async () =>
      (await api.get<{ threads: ThreadRow[] }>("/api/threads?limit=100")).threads,
  });
}

/** Single message fetch — the thread screen's root fallback when the root
    isn't in the loaded top-level window (inbox, notification, deep link). */
export function useMessage(messageId: number, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.message(messageId),
    queryFn: () => api.get<Message>(`/api/messages/${messageId}`),
    enabled,
  });
}

/** Dismiss a thread from the inbox — the channel keeps its messages. */
export function useHideThread() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: number) => api.put(`/api/threads/${threadId}/hide`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.threads }),
  });
}

/** Rename a thread with a display alias (empty string clears it back to the
    root message's first line). The threads cache is patched by the WS
    "thread_renamed" echo; invalidate as a fallback. */
export function useRenameThread() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { threadId: number; alias: string }) =>
      api.patch(`/api/threads/${v.threadId}`, { alias: v.alias }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.threads }),
  });
}

export function useMarkThreadRead(threadId: number) {
  const api = useApi();
  return useMutation({
    mutationFn: (lastReadId: number | null) =>
      api.put<{ ok: boolean; last_read_id: number }>(
        `/api/threads/${threadId}/read`,
        { last_read_id: lastReadId },
      ),
    // Threads cache is patched by the WS "thread_read" echo.
  });
}

/* ------------------------------------------------------------- pins & stars */

export function usePins(channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.pins(channelId),
    queryFn: async () =>
      (await api.get<{ pins: PinnedMessage[] }>(`/api/channels/${channelId}/pins`)).pins,
    enabled: !!channelId,
  });
}

export function usePinMessage(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { messageId: number; pinned: boolean }) =>
      v.pinned
        ? api.put(`/api/channels/${channelId}/pins/${v.messageId}`)
        : api.delete(`/api/channels/${channelId}/pins/${v.messageId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.pins(channelId) }),
  });
}

export function useStars(channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.stars(channelId),
    queryFn: async () =>
      (await api.get<{ stars: StarredMessage[] }>(`/api/channels/${channelId}/stars`)).stars,
    enabled: !!channelId,
  });
}

export function useStarMessage(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { messageId: number; starred: boolean }) =>
      v.starred
        ? api.put(`/api/channels/${channelId}/stars/${v.messageId}`)
        : api.delete(`/api/channels/${channelId}/stars/${v.messageId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.stars(channelId) }),
  });
}

/* ------------------------------------------------------------- agents & activity */

export function useChannelAgents(channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.channelAgents(channelId),
    queryFn: async () =>
      (await api.get<{ agents: ChannelAgent[] }>(`/api/channels/${channelId}/agents`)).agents,
    enabled: !!channelId,
  });
}

/** Fetch in-flight typing/progress once per channel open and seed the live
    store; afterwards WS frames keep it current. */
export function useSeedActivity(channelId: string) {
  const api = useApi();
  const query = useQuery({
    queryKey: keys.activity(channelId),
    queryFn: () => api.get<ChannelActivity>(`/api/channels/${channelId}/activity`),
    staleTime: Infinity,
    enabled: !!channelId,
  });
  const seed = useLive((s) => s.seed);
  useEffect(() => {
    if (query.data) seed(channelId, query.data);
  }, [channelId, query.data, seed]);
}

export function useAgents(staleTime?: number) {
  const api = useApi();
  return useQuery({
    queryKey: keys.agents,
    queryFn: async () =>
      (await api.get<{ agents: AgentInfo[] }>("/api/agents")).agents,
    staleTime,
  });
}

export function useAgentDms() {
  const api = useApi();
  return useQuery({
    queryKey: keys.dms,
    queryFn: () => api.get<AgentDmList>("/api/dms"),
  });
}

export function useOpenAgentDm() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.post<Channel>(`/api/dms/${encodeURIComponent(agentId)}`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.dms });
      void qc.invalidateQueries({ queryKey: keys.groups });
    },
  });
}

export function useAgentDmPolicy(agentId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentDmPolicy(agentId),
    queryFn: () => api.get<AgentDmPolicy>(`/api/admin/agents/${encodeURIComponent(agentId)}/dm-policy`),
    enabled: enabled && !!agentId,
  });
}

export function useUpdateAgentDmPolicy(agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policy: Pick<AgentDmPolicy, "is_public" | "grants">) =>
      api.put<AgentDmPolicy>(`/api/admin/agents/${encodeURIComponent(agentId)}/dm-policy`, policy),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.agentDmPolicy(agentId) });
      void qc.invalidateQueries({ queryKey: keys.dms });
    },
  });
}

export function useForgetAgent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.delete(`/api/agents/${encodeURIComponent(agentId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.agents }),
  });
}

/* ------------------------------------------------------------- connections & pairing */

/** Poll while the settings screen is open, like the desktop pane (4s).
    Instance-admin only — pass `enabled: false` for regular members so the
    screen doesn't hammer a 403ing endpoint. */
export function useConnections(poll = false, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.connections,
    queryFn: async () =>
      (await api.get<{ connections: Connection[] }>("/api/connections")).connections,
    refetchInterval: poll ? 4000 : false,
    enabled,
  });
}

/** Full GET /api/connections payload — the instance identity rides on it
    (there is no GET /api/instance). Used by the admin Connections pane. */
export function useConnectionsInfo(poll = false, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.connectionsInfo,
    queryFn: () =>
      api.get<{ connections: Connection[]; instance: InstanceInfo | null }>("/api/connections"),
    refetchInterval: poll ? 4000 : false,
    enabled,
  });
}

export function useConnectionMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keys.connections });
    void qc.invalidateQueries({ queryKey: keys.connectionsInfo });
    void qc.invalidateQueries({ queryKey: keys.agentSources });
  };
  return {
    add: useMutation({
      mutationFn: (v: { name: string; url: string; token: string }) =>
        api.post("/api/connections", v),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (v: { name: string; url?: string; token?: string; enabled?: boolean }) =>
        api.put(`/api/connections/${encodeURIComponent(v.name)}`, v),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (name: string) =>
        api.delete(`/api/connections/${encodeURIComponent(name)}`),
      onSuccess: invalidate,
    }),
  };
}

export function usePairingTokens(enabled = true, poll = false) {
  const api = useApi();
  return useQuery({
    queryKey: keys.pairing,
    queryFn: async () =>
      (await api.get<{ tokens: PairingToken[] }>("/api/pairing")).tokens,
    refetchInterval: poll ? 4000 : false,
    enabled,
  });
}

export function useAgentSources(enabled = true, poll = false) {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentSources,
    queryFn: async () =>
      (await api.get<{ sources: AgentSource[] }>("/api/admin/sources")).sources,
    enabled,
    refetchInterval: poll ? 4000 : false,
  });
}

export function usePairingMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: keys.pairing });
    void qc.invalidateQueries({ queryKey: keys.agentSources });
  };
  return {
    create: useMutation({
      mutationFn: (v: { name: string; kind?: PairingToken["kind"] }) =>
        api.post<{ token: string }>("/api/pairing", v),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (token: string) => api.delete(`/api/pairing/${encodeURIComponent(token)}`),
      onSuccess: invalidate,
    }),
  };
}

/* ------------------------------------------------------------- instance */

export function useRenameInstance() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.put("/api/instance", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connectionsInfo }),
  });
}

/** Instance-admin voice + Ask-AI settings (keys masked). */
export function useInstanceAi(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.instanceAi,
    queryFn: () => api.get<InstanceAiSettings>("/api/instance/ai"),
    enabled,
  });
}

export function useUpdateInstanceAi() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: InstanceAiUpdate) =>
      api.put<InstanceAiSettings>("/api/instance/ai", patch),
    onSuccess: (data) => {
      qc.setQueryData(keys.instanceAi, data);
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useTestInstanceAi() {
  const api = useApi();
  return useMutation({
    mutationFn: (provider: "openai" | "anthropic" | "codex") =>
      api.post<{ ok: boolean; provider: string }>("/api/instance/ai/test", { provider }),
  });
}

export type CodexOauthStartResult = {
  ok: boolean;
  mode: "loopback" | "paste";
  authorize_url: string;
  redirect_uri: string;
};

export type CodexOauthStatusResult = {
  status: "idle" | "pending" | "completed" | "failed" | "expired";
  mode?: "loopback" | "paste";
  error?: string | null;
};

export function useStartCodexOauth() {
  const api = useApi();
  return useMutation({
    mutationFn: (mode: "loopback" | "paste") =>
      api.post<CodexOauthStartResult>("/api/instance/ai/codex/oauth/start", { mode }),
  });
}

export function useCodexOauthStatus(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.instanceAi, "codex-oauth-status"] as const,
    queryFn: () => api.get<CodexOauthStatusResult>("/api/instance/ai/codex/oauth/status"),
    enabled,
    refetchInterval: enabled ? 1500 : false,
  });
}

export function useCompleteCodexOauth() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (redirect_url: string) =>
      api.post<{ ok: boolean; account_id?: string }>(
        "/api/instance/ai/codex/oauth/complete",
        { redirect_url },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.instanceAi });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useDisconnectCodexOauth() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>("/api/instance/ai/codex/oauth/disconnect", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.instanceAi });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

/* ------------------------------------------------------------- users & invites */

/** Change a user's instance role or disable/enable the account. */
export function useUpdateUser() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { username: string; instance_role?: string; disabled?: boolean }) =>
      api.patch(`/api/users/${encodeURIComponent(v.username)}`, {
        ...(v.instance_role !== undefined ? { instance_role: v.instance_role } : {}),
        ...(v.disabled !== undefined ? { disabled: v.disabled } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.users }),
  });
}

/** Email invites + single-use invite links, in one payload like the API. */
export function useInvites(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.invites,
    queryFn: () => api.get<{ invites: Invite[]; links: InviteLink[] }>("/api/invites"),
    enabled,
  });
}

/** Email invite ({email, instance_role}) or single-use link ({link: true,
    instance_role}) — the latter returns the join URL/token. */
export function useCreateInvite() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email?: string; link?: boolean; instance_role?: string }) =>
      api.post<Invite | InviteLink>("/api/invites", v),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites }),
  });
}

export function useRevokeInvite() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => api.delete(`/api/invites/${encodeURIComponent(email)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites }),
  });
}
