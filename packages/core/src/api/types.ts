/* Payload shapes mirrored from crates/agora-core/src/{server,store,hub}.rs.
   There is no shared schema with the Rust server; the integration tests are
   what keep these honest. */

export interface Me {
  username: string;
  display_name?: string;
  /** Operator powers: connections, pairing tokens, users & invites. */
  instance_admin?: boolean;
  version: string;
  /** Per-file upload limit advertised by current servers; older servers omit it. */
  max_file_mb?: number;
  /** Per-video upload limit advertised by current servers. */
  max_video_mb?: number;
  /** Server has some voice capability — STT or TTS. Coarse; prefer the two
      flags below, since STT and TTS can come from different providers and one
      can be configured without the other. */
  voice?: boolean;
  /** Transcription is available: show the composer mic / voice notes. */
  voice_stt?: boolean;
  /** Synthesis is available: show speak-aloud. Live voice needs both. */
  voice_tts?: boolean;
  /** Server has Ask AI available (instance AI settings or env key). */
  search_ai?: boolean;
  /** Operator-configured MapLibre style URL for map artifacts; empty/absent
      means clients fall back to the coordinate-only SVG map. */
  map_style_url?: string;
}

/** One workspace account from GET /api/users (any signed-in user may list
    them — it feeds the add-person picker). */
export interface UserInfo {
  username: string;
  display_name: string;
  email: string | null;
  instance_role: "admin" | "member";
  created_at: number;
  disabled: boolean;
}

export interface Channel {
  id: string;
  group_id: string;
  name: string;
  topic: string;
  created_at: number;
  /** Tucked away in the home list (admin toggle); data is untouched. */
  hidden?: boolean;
  /* Embedded by the groups endpoint only. `unread` counts top-level
     messages; `mentions` counts @you messages (any thread). */
  unread?: number;
  mentions?: number;
  last_read_id?: number;
  kind?: "channel" | "agent_dm";
  dm_user_id?: string | null;
  dm_agent_id?: string | null;
  dm_can_post?: boolean;
  /** The caller's effective role in this channel. */
  role?: "admin" | "member";
}

export interface Group {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: number;
  channels: Channel[];
  role: "admin" | "member";
  /** Tucked away in the home list (admin toggle); data is untouched. */
  hidden?: boolean;
  /** Open to every signed-in user, membership or not (admin toggle). */
  is_public?: boolean;
  kind?: "agent_dms";
}

export interface AgentDmConversation {
  channel_id: string;
  agent_id: string;
  agent_name: string;
  last_seen: number;
  unread: number;
}

export interface AgentDmCandidate {
  id: string;
  name: string;
  live: boolean;
  can_dm: boolean;
  is_public: boolean;
}

export interface AgentDmList {
  conversations: AgentDmConversation[];
  agents: AgentDmCandidate[];
}

export interface AgentDmPolicy {
  agent_id: string;
  is_public: boolean;
  grants: string[];
}

export interface MessageTemplate {
  id: string;
  group_id: string;
  label: string;
  text: string;
  created_at: number;
  updated_at: number;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface MessageOption {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default" | string;
}

/** One element of an interactive form (meta.form): a text input or a
    checkbox. `value` is the agent-supplied initial value; the live values
    everyone shares live in meta.form_state, keyed by field id. */
export interface FormField {
  id: string;
  kind: "input" | "checkbox";
  label: string;
  placeholder?: string;
  value?: string | boolean;
}

export interface FormButton {
  id: string;
  label: string;
  style?: "primary" | "secondary" | string;
}

/** An agent-authored interactive form rendered inside the message bubble.
    Shared, one-shot: any member edits the same state, the first button
    press locks it (meta.form_submitted) for everyone. */
export interface MessageForm {
  fields: FormField[];
  buttons: FormButton[];
}

/** One column of an interactive table (meta.table). */
export interface MessageTableColumn {
  id: string;
  label: string;
  kind: "text" | "number" | "readonly";
  /** Optional CSS-px width hint from the agent. */
  width?: number;
}

export interface MessageTableAction {
  id: string;
  label: string;
  style?: "primary" | "secondary" | string;
}

export interface MessageTableRow {
  id: string;
  cells: Record<string, string | number>;
  actions: MessageTableAction[];
}

/** An agent-authored editable table of records inside a message bubble.
    Cell edits share `meta.table_state`; a row action locks that row in
    `meta.table_rows`; a table-level button locks the rest via
    `meta.table_submitted`. */
export interface MessageTable {
  columns: MessageTableColumn[];
  rows: MessageTableRow[];
  buttons: FormButton[];
}

/** Link metadata for source chips and unfurl cards. Entries start as bare
    URLs; the server enriches them asynchronously (title/description/image
    arrive on a message_update once the page is fetched). */
export interface ArtifactPosition {
  lat: number;
  lng: number;
}

export interface MapArtifactRegion {
  id: string;
  label: string;
  center: ArtifactPosition;
  day_ids: string[];
}

export interface MapArtifactDay {
  id: string;
  number: number;
  label: string;
  region_id?: string;
  place_ids: string[];
}

export type MapArtifactCategory =
  | "sight" | "food" | "hotel" | "activity" | "transport"
  | "shopping" | "nature" | "other";

export interface MapArtifactPlace {
  id: string;
  label: string;
  position: ArtifactPosition;
  region_id?: string;
  day_ids: string[];
  order?: number;
  category: MapArtifactCategory;
  description?: string;
  start_time?: string;
  duration_minutes?: number;
  google_place_id?: string;
}

export interface MapArtifactRoute {
  id: string;
  kind: "overview" | "day";
  label?: string;
  place_ids: string[];
  region_ids: string[];
  coordinates: [number, number][];
}

export interface MapArtifactData {
  initial_view: { mode: "fit" };
  regions: MapArtifactRegion[];
  days: MapArtifactDay[];
  places: MapArtifactPlace[];
  routes: MapArtifactRoute[];
}

export interface MessageArtifact<T = unknown> {
  id: string;
  type: string;
  version: number;
  title: string;
  summary?: string;
  data?: T;
  unsupported?: boolean;
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  site?: string;
}

export interface MessageMeta {
  /** Unix seconds when a human author last changed the message text. */
  edited_at?: number;
  options?: MessageOption[];
  options_id?: string;
  resolved?: {
    option_id: string;
    by?: string;
    label?: string;
    ts?: number;
  } | null;
  /* Agent-supplied short version of a long message; the UI can swap the
     bubble between it and the full text. */
  tldr?: string;
  /* Cited URLs — sent structured by the agent or lifted server-side from a
     trailing "Sources:" block; rendered as chips + viewer, never raw. */
  sources?: LinkPreview[];
  /* UTF-16 offset into `text` where a detected trailing sources block
     starts (String.slice units); clients cut the text there. */
  sources_start?: number;
  /* Server-fetched previews for (non-source) links in the prose. */
  unfurls?: LinkPreview[];
  /* Interactive form: spec, shared live values, and the one-shot lock. */
  form?: MessageForm;
  form_id?: string;
  form_state?: Record<string, string | boolean>;
  form_submitted?: {
    button_id: string;
    by?: string;
    ts?: number;
    values?: Record<string, string | boolean>;
  } | null;
  /* Interactive table: spec, shared live cells, per-row locks, table lock. */
  table?: MessageTable;
  table_id?: string;
  table_state?: Record<string, Record<string, string | number>>;
  table_rows?: Record<
    string,
    {
      action_id: string;
      by?: string;
      ts?: number;
      values?: Record<string, string | number>;
    }
  >;
  table_submitted?: {
    button_id: string;
    by?: string;
    ts?: number;
    rows?: Record<string, Record<string, string | number>>;
  } | null;
  /* Agent-authored, server-sanitized presentation data. Clients dispatch on
     type + version and degrade visibly when they do not support a renderer. */
  artifacts?: MessageArtifact[];
}

/** One emoji's reactions on a message; users in reaction order, so the
    count is `users.length` and "did I react" is a membership test. */
export interface Reaction {
  emoji: string;
  users: string[];
  /** Typed identities from newer servers. `users` remains for compatibility. */
  reactors?: ReactionReactor[];
}

export interface ReactionReactor {
  type: "user" | "agent";
  id: string;
  /** Server-resolved fallback; clients may prefer their live roster name. */
  name: string;
}

export interface Message {
  id: number;
  channel_id: string;
  thread_id: number | null;
  author_type: "user" | "agent";
  author_id: string;
  author_name: string | null;
  text: string;
  ts: number;
  attachments: Attachment[];
  reactions?: Reaction[];
  meta?: MessageMeta | null;
  /* Top-level pages only. */
  reply_count?: number;
  /* Thread roots only: a user-chosen display name, else null. */
  alias?: string | null;
}

/** Message hit from GET /api/search. Search rows carry channel/group names
    for breadcrumbs and a `snippet` with matched terms wrapped in
    U+0001…U+0002, plus the message's `attachments` (filenames are searchable
    and the file filter matches on them). */
export interface SearchMessageHit extends Omit<Message, "attachments"> {
  attachments?: Attachment[];
  channel_name: string;
  group_id: string;
  group_name: string;
  snippet: string;
}

/** One file in the channel/thread attachment browser. */
export interface AttachmentBrowserItem extends Attachment {
  channel_id: string;
  message_id: number;
  thread_id: number | null;
  author_type: "user" | "agent";
  author_id: string;
  author_name: string | null;
  message_text: string;
  ts: number;
  thread_name: string | null;
  can_delete: boolean;
}

export interface AttachmentPage {
  items: AttachmentBrowserItem[];
  has_more: boolean;
  offset: number;
}

export interface SearchChannelHit {
  id: string;
  group_id: string;
  name: string;
  topic: string;
  hidden: boolean;
  group_name: string;
}

export interface SearchGroupHit {
  id: string;
  name: string;
  description: string;
  hidden: boolean;
}

export interface SearchMessagesPage {
  items: SearchMessageHit[];
  has_more: boolean;
  offset: number;
}

/** GET /api/search — sections are present only for the requested `types`. */
export interface SearchResponse {
  query: string;
  messages?: SearchMessagesPage;
  channels?: SearchChannelHit[];
  groups?: SearchGroupHit[];
}

/** POST /api/search/ask — [n] in `answer` cites sources[n-1]; a null answer
    means no matching messages (`detail` explains). */
export interface AskResponse {
  answer: string | null;
  model?: string;
  sources: SearchMessageHit[];
  detail?: string;
}

/** One row of GET /api/threads: a thread the user participates in. */
export interface ThreadRow {
  root: Message;
  channel_id: string;
  channel_name: string;
  group_id: string;
  group_name: string;
  reply_count: number;
  last_reply_id: number;
  last_reply_ts: number;
  last_read_id: number;
  unread: number;
}

export interface StarredMessage extends Message {
  starred_at: number;
  root: Message | null;
}

export interface PinnedMessage extends Message {
  pinned_by: string | null;
  pinned_at: number;
}

export interface Member {
  channel_id: string | null;
  member_type: "user" | "agent";
  member_id: string;
  role: string;
  added_at: number;
  /* Agents get their display name resolved server-side. */
  name?: string;
}

export interface InstanceMembership extends Member {
  group_id: string;
  group_name: string;
  channel_name: string | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  source: string;
  requires_mention: boolean;
  last_seen: number;
  live: boolean;
  avatar: string | null;
}

export interface ChannelAgent {
  id: string;
  name: string;
}

export interface TypingEvent {
  type: "typing";
  channel_id: string;
  thread_id: number | null;
  agent_id: string;
  agent_name: string;
  active: boolean;
}

export interface ProgressEvent {
  type: "progress";
  channel_id: string;
  thread_id: number | null;
  agent_id: string;
  agent_name: string;
  handle: string;
  text: string;
}

export interface MessageEvent {
  type: "message";
  message: Message;
}

export interface ReadEvent {
  type: "read";
  channel_id: string;
  last_read_id: number;
}

export interface ThreadReadEvent {
  type: "thread_read";
  thread_id: number;
  channel_id: string;
  last_read_id: number;
}

export interface ThreadRenamedEvent {
  type: "thread_renamed";
  thread_id: number;
  channel_id: string;
  alias: string | null;
}

export interface PinEvent {
  type: "pin";
  channel_id: string;
  pinned: boolean;
  pin?: PinnedMessage;
  message_id?: number;
}

export interface MessageUpdateEvent {
  type: "message_update";
  message: Message;
}

/** A message was deleted (sender or an admin). A null thread_id means a
    top-level message went — roots take their whole thread with them. */
export interface MessageDeleteEvent {
  type: "message_delete";
  channel_id: string;
  message_id: number;
  thread_id: number | null;
}

export type WsEvent =
  | TypingEvent
  | ProgressEvent
  | MessageEvent
  | MessageUpdateEvent
  | MessageDeleteEvent
  | ReadEvent
  | ThreadReadEvent
  | ThreadRenamedEvent
  | PinEvent;

export interface ChannelActivity {
  typing: TypingEvent[];
  progress: ProgressEvent[];
}

export interface ConnStatus {
  name: string;
  url: string;
  connected: boolean;
  agents: { id: string; name: string }[];
  last_error: string | null;
}

export interface Connection {
  name: string;
  url: string;
  enabled: boolean;
  status: ConnStatus | null;
}

export interface PairingToken {
  id: string;
  token: string;
  name: string;
  kind?: PairingKind;
  created_at: number;
  /* Live dial-in status, merged from the hub at request time: a socket for
     this token is up, and the agents it registered (empty until its hello). */
  connected?: boolean;
  agents?: { id: string; name: string }[];
}

export interface AgentSourceAgent {
  id: string;
  name: string;
  live: boolean;
  last_seen: number;
}

export interface AgentSource {
  kind: "pantheo" | "pairing";
  id: string;
  name: string;
  agents: AgentSourceAgent[];
}

export const PAIRING_KINDS = ["claw", "hermes", "codex", "cursor", "claude"] as const;
export type PairingKind = typeof PAIRING_KINDS[number];

export interface InstanceInfo {
  id: string;
  name: string;
}

export interface Invite {
  email: string;
  instance_role: string;
  invited_by?: string | null;
  accepted_at?: number | null;
}

export interface InviteLink {
  token: string;
  url: string;
  instance_role: string;
  invited_by?: string | null;
  used_by?: string | null;
  expires_at: number;
}

/** Where a resolved AI field came from (admin API). */
export type AiFieldSource = "config" | "env" | "default" | "none";

export interface AiSecretField {
  configured: boolean;
  hint: string | null;
  source: AiFieldSource;
}

export interface AiValueField {
  value: string;
  source: AiFieldSource;
}

export interface InstanceAiVoice {
  /** Admin kill-switch per half — they are configured and credentialed
      separately, so they turn off separately. */
  stt_enabled: boolean;
  tts_enabled: boolean;
  /** Either half is usable. */
  available: boolean;
  /** Transcription half — enabled and the selected STT provider has a key. */
  stt_available: boolean;
  /** Synthesis half — enabled and the selected TTS provider has a key. */
  tts_available: boolean;
  stt_provider: string;
  tts_provider: string;
  api_key: AiSecretField;
  stt_model: AiValueField;
  stt_models: {
    openai: AiValueField;
    groq: AiValueField;
  };
  suggested_stt_models: string[];
  suggested_stt_models_by_provider: Record<string, string[]>;
  stt_providers: InstanceAiProviderOption[];
  tts_providers: InstanceAiProviderOption[];
  tts_model: AiValueField;
  tts_voice: AiValueField;
  suggested_tts_voices: string[];
}

export interface InstanceAiProviderOption {
  id: string;
  label: string;
}

export interface InstanceAiSearch {
  enabled: boolean;
  available: boolean;
  provider: string;
  providers: InstanceAiProviderOption[];
  model: AiValueField;
  models: {
    anthropic: AiValueField;
    openai: AiValueField;
    codex: AiValueField;
  };
  suggested_models: string[];
  suggested_models_by_provider: Record<string, string[]>;
}

export interface InstanceAiCredentials {
  openai: AiSecretField;
  groq: AiSecretField;
  anthropic: AiSecretField;
  oauth: {
    configured: boolean;
    source: AiFieldSource;
    hint: string | null;
    account_id: string | null;
    redirect_uri: string;
  };
}

/** GET /api/instance/ai — instance-admin voice + Ask-AI settings. */
export interface InstanceAiSettings {
  voice: InstanceAiVoice;
  search: InstanceAiSearch;
  credentials: InstanceAiCredentials;
}

export type InstanceAiUpdate = {
  voice?: {
    stt_enabled?: boolean;
    tts_enabled?: boolean;
    stt_provider?: string;
    tts_provider?: string;
    api_key?: string;
    clear_key?: boolean;
    stt_model?: string;
    stt_model_provider?: string;
    stt_models?: Partial<Record<"openai" | "groq", string>>;
    tts_model?: string;
    tts_voice?: string;
  };
  search?: {
    enabled?: boolean;
    provider?: string;
    api_key?: string;
    clear_key?: boolean;
    model?: string;
    model_provider?: string;
    models?: Partial<Record<"anthropic" | "openai" | "codex", string>>;
    clear_oauth?: boolean;
  };
  credentials?: {
    openai?: { api_key?: string; clear_key?: boolean };
    groq?: { api_key?: string; clear_key?: boolean };
    anthropic?: { api_key?: string; clear_key?: boolean };
    clear_oauth?: boolean;
  };
};

/* The server rejects messages and templates longer than this (MAX_MESSAGE_CHARS
   in agora-core), so both clients cap their inputs at the same number. */
export const MAX_MESSAGE_CHARS = 20_000;

/* Keep template labels aligned with MAX_TEMPLATE_LABEL_CHARS in the server. */
export const MAX_TEMPLATE_LABEL_CHARS = 80;
