/* Group and channel rosters share the same access rules; details and mutations
   live in sheets so the roster stays readable as membership grows. */
import React, { useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { Bot, Check, ChevronLeft, ChevronRight, Search, Users } from "lucide-react-native";
import {
  useAddMember, useAgents, useGroups, useMembers, useRemoveMember, useUsers, visibleMembershipScopes,
} from "@agora/core";
import type { AgentInfo, Member, UserInfo } from "@agora/core";
import { AgentAvatar } from "../../../src/components/AgentAvatar";
import { Icon } from "../../../src/components/Icon";
import { SheetHeader } from "../../../src/components/SheetHeader";
import { ResponsiveText as Text } from "../../../src/components/ResponsiveText";
import { toast, toastErr } from "../../../src/components/Toast";
import { typography, weight } from "../../../src/lib/theme";
import { createThemedStyles, useAppTheme } from "../../../src/lib/useTheme";
import { useSession } from "../../../src/state/session";
import { ParticipantAccessFields } from "../../../src/components/ParticipantAccessFields";
import { accessDraft, applyAccess, planAccess, type AccessDraft, type AccessPermissions, type AccessRole } from "../../../src/lib/participantAccess";

function MemberSheet({ title, onClose, children }: React.PropsWithChildren<{ title: string; onClose: () => void }>) {
  const styles = useStyles();
  return <Modal transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={onClose} />
      <View accessibilityViewIsModal style={styles.sheet}>
        <SheetHeader title={title} onClose={onClose} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>{children}</ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}
function PersonAvatar({ name }: { name: string }) {
  const styles = useStyles();
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  return <View accessible={false} style={styles.avatar}><Text maxFontSizeMultiplier={1.2} style={styles.initials}>{initials || "?"}</Text></View>;
}
function scopeLabel(scope: Member, channelName: (id: string | null) => string | null) {
  return scope.channel_id ? `#${channelName(scope.channel_id)}` : "Whole group";
}
function scopeSummary(scopes: Member[], channelName: (id: string | null) => string | null, person = false) {
  const whole = scopes.find(scope => !scope.channel_id);
  if (whole) return person ? `Group ${whole.role === "admin" ? "admin" : "member"}` : "All channels";
  if (scopes.length === 1) return `${person ? (scopes[0].role === "admin" ? "Admin · " : "Member · ") : ""}${scopeLabel(scopes[0], channelName)}`;
  return `${scopes.length} channels${person && scopes.some(scope => scope.role === "admin") ? " · admin access" : ""}`;
}
function BackStep({ onPress }: { onPress: () => void }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel="Back to previous step" style={styles.backStep} onPress={onPress}>
    <Icon icon={ChevronLeft} size={16} /><Text style={styles.link}>Back</Text>
  </Pressable>;
}
function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return <View style={styles.search}><Icon icon={Search} size={17} color={colors.faint} />
    <TextInput accessibilityLabel={placeholder} placeholder={placeholder} placeholderTextColor={colors.faint}
      value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} style={styles.searchInput} clearButtonMode="while-editing" />
  </View>;
}

type PickerStatus = { loading?: boolean; error?: boolean; onRetry?: () => void };
type AddPickerProps = PickerStatus & {
  channels: { id: string; name: string }[]; memberships?: Member[]; pending: boolean;
  onCancel: () => void; allowWholeGroup?: boolean; channelFocused?: boolean; initialChannelId?: string;
};
type Candidate = { id: string; name: string; detail: string };
function AddParticipants({ candidates, kind, total = 0, channels, memberships = [], pending, onAdd, onCancel, allowWholeGroup = true, channelFocused = false, initialChannelId, loading, error, onRetry }: AddPickerProps & {
  candidates: Candidate[]; kind: "user" | "agent"; total?: number;
  onAdd: (id: string, role: AccessRole, channelId: string | null) => void | Promise<unknown>;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<"participants" | "access">("participants");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  // Track individual grants so retrying a partial batch never repeats completed work.
  const completed = useRef(new Set<string>());
  const [draft, setDraft] = useState<AccessDraft>({ mode: initialChannelId || !allowWholeGroup ? "channels" : "group", role: "member",
    channels: initialChannelId ? { [initialChannelId]: "member" } : {} });
  const busy = pending || saving;
  const filtered = candidates.filter(candidate => (candidate.name + " " + candidate.detail).toLowerCase().includes(query.trim().toLowerCase()));
  const grants = draft.mode === "group" ? [[null, draft.role] as const] : Object.entries(draft.channels);
  const close = () => { if (!busy) onCancel(); };
  const submit = async () => {
    if (busy) return;
    setSaving(true); setFailure("");
    try {
      for (const id of selected) for (const [channelId, role] of grants) {
        const key = JSON.stringify([id, channelId]);
        const existing = memberships.some(scope => scope.member_id === id && (!scope.channel_id || scope.channel_id === channelId));
        if (existing || completed.current.has(key)) continue;
        await onAdd(id, kind === "agent" ? "member" : role, channelId);
        completed.current.add(key);
      }
      toast("Participants added. Existing access was kept.");
      onCancel();
    } catch (e) {
      setFailure("Some access may already be saved. Retry will skip completed additions. " + (e instanceof Error ? e.message : "Please try again."));
    } finally { setSaving(false); }
  };
  const confirmSubmit = () => {
    if (kind === "user" && draft.mode === "group" && memberships.some(scope => selected.includes(scope.member_id) && scope.channel_id)) {
      Alert.alert("Apply whole-group access?", "For people with channel-specific access, this replaces their individual channel roles with the selected group role.",
        [{ text: "Cancel", style: "cancel" }, { text: "Apply access", onPress: () => void submit() }]);
    } else void submit();
  };
  return <MemberSheet title={step === "access" ? "Set access" : kind === "user" ? "Add people" : "Add agents"} onClose={close}>
    {step === "participants" ? <>
      <Text style={styles.hint}>Select one or more {kind === "user" ? "people" : "agents"} to add.</Text>
      {candidates.length ? <SearchField value={query} onChange={setQuery} placeholder={kind === "user" ? "Search people" : "Search agents"} /> : null}
      {loading ? <Text style={styles.feedback}>Loading…</Text> : error ? <View style={styles.accessCard}><Text style={styles.hint}>Couldn't load the available members.</Text><Pressable accessibilityRole="button" onPress={onRetry} style={styles.backStep}><Text style={styles.link}>Try again</Text></Pressable></View> : !candidates.length ? <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>{kind === "user" ? "Everyone already has access" : total ? `All agents are already in this ${channelFocused ? "channel" : "group"}` : "No agents connected yet"}</Text>
        <Text style={styles.hint}>{kind === "user" ? "Manage existing access from the participant list. Instance admins can invite new people from the web app." : total ? "You can manage their access from the agent list." : "Connect an agent on the Agents page, then add it here."}</Text>
        {kind === "agent" && !total ? <Link href="/(app)/agents" onPress={close} style={styles.link}>Open Agents</Link> : null}
      </View> : null}
      {!loading && !error ? filtered.map(candidate => <Pressable key={candidate.id} accessibilityRole="checkbox" accessibilityLabel={`Select ${candidate.name}`}
        accessibilityState={{ checked: selected.includes(candidate.id) }} style={styles.optionRow}
        onPress={() => setSelected(current => current.includes(candidate.id) ? current.filter(id => id !== candidate.id) : [...current, candidate.id])}>
        {kind === "user" ? <PersonAvatar name={candidate.name} /> : <AgentAvatar agentId={candidate.id} size={36} />}
        <View style={styles.identity}><Text style={styles.name}>{candidate.name}</Text><Text style={styles.meta}>{candidate.detail}</Text></View>
        <View style={[styles.check, selected.includes(candidate.id) && styles.checked]}>{selected.includes(candidate.id) ? <Icon icon={Check} size={14} color={colors.a1} /> : null}</View>
      </Pressable>) : null}
      {candidates.length > 0 && !filtered.length ? <Text style={styles.feedback}>No matches. Try another name.</Text> : null}
      {candidates.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="Continue to access" disabled={!selected.length || !!loading || !!error} style={[styles.primary, !selected.length && styles.disabled]} onPress={() => setStep("access")}><Text style={styles.primaryText}>Continue{selected.length ? ` · ${selected.length} selected` : ""}</Text></Pressable> : null}
    </> : <>
      <BackStep onPress={() => { if (!busy) setStep("participants"); }} />
      <Text style={styles.name}>{selected.length} {kind === "user" ? "people" : "agents"} selected</Text>
      <ParticipantAccessFields value={draft} onChange={value => { if (!busy) setDraft(value); }} channels={channels}
        permissions={{ groupAdmin: allowWholeGroup, channelIds: channels.map(channel => channel.id) }} person={kind === "user"} disabled={busy} />
      <Text style={styles.hint}>{draft.mode === "group" && kind === "user" ? "One group role applies to everyone selected, replacing any channel-specific roles." : "This applies to everyone selected. Existing channel access and roles won't be changed."}</Text>
      {failure ? <Text accessibilityRole="alert" style={styles.destructiveText}>{failure}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Add selected participants" disabled={busy || !grants.length} style={[styles.primary, (busy || !grants.length) && styles.disabled]} onPress={confirmSubmit}><Text style={styles.primaryText}>{busy ? "Adding…" : failure ? "Retry remaining additions" : "Add participants"}</Text></Pressable>
    </>}
  </MemberSheet>;
}
export function AddAgent({ agents: availableAgents, totalAgents, onAdd, ...props }: AddPickerProps & {
  agents: AgentInfo[]; totalAgents: number; onAdd: (agent: AgentInfo, channelId: string | null) => void | Promise<unknown>;
}) {
  // Successful additions invalidate the roster during a batch. Keep identities
  // stable until the sheet closes rather than losing the next selected person.
  const known = useRef(new Map<string, AgentInfo>());
  for (const agent of availableAgents) known.current.set(agent.id, agent);
  const agents = [...known.current.values()];
  return <AddParticipants {...props} kind="agent" total={totalAgents} candidates={agents.map(agent => ({ id: agent.id, name: agent.name, detail: agent.live ? "Online" : "Offline" }))}
    onAdd={(id, _role, channelId) => onAdd(agents.find(agent => agent.id === id)!, channelId)} />;
}
export function AddPerson({ users: availableUsers, onAdd, ...props }: AddPickerProps & {
  users: UserInfo[]; onAdd: (user: UserInfo, role: AccessRole, channelId: string | null) => void | Promise<unknown>;
}) {
  const known = useRef(new Map<string, UserInfo>());
  for (const user of availableUsers) known.current.set(user.username, user);
  const users = [...known.current.values()];
  return <AddParticipants {...props} kind="user" candidates={users.map(user => ({ id: user.username, name: user.display_name || user.username, detail: "@" + user.username }))}
    onAdd={(id, role, channelId) => onAdd(users.find(user => user.username === id)!, role, channelId)} />;
}

function AccessEditor({ scopes, channels, permissions, isSelf, instanceAdmin, isPublic, onSave, onRemove, onLeave, onClose }: {
  scopes: Member[]; channels: { id: string; name: string }[]; permissions: AccessPermissions;
  isSelf: boolean; instanceAdmin: boolean; isPublic: boolean; onSave: (draft: AccessDraft) => Promise<void>;
  onRemove: (scope: Member) => void; onLeave?: () => void; onClose: () => void;
}) {
  const styles = useStyles();
  const [draft, setDraft] = useState(() => accessDraft(scopes));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const original = accessDraft(scopes);
  const person = scopes[0].member_type === "user";
  const inherited = original.mode === "group" && !permissions.groupAdmin;
  const editable = !inherited && (permissions.groupAdmin || permissions.channelIds.length > 0);
  // Removing one's own global row also revokes the authority needed to add narrower rows.
  const lockScope = person && isSelf && !instanceAdmin && original.mode === "group";
  const name = scopes[0].name || scopes[0].member_id;
  const dirty = JSON.stringify(original) !== JSON.stringify(draft);
  const close = () => {
    if (saving) return;
    if (dirty && !failed) Alert.alert("Discard changes?", "Your access changes haven't been saved.", [{ text: "Keep editing", style: "cancel" }, { text: "Discard", style: "destructive", onPress: onClose }]);
    else onClose();
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try { await onSave(draft); onClose(); }
    catch (e) { setFailed(true); toastErr("Access update failed", e); }
    finally { setSaving(false); }
  };
  const submit = () => {
    if (original.mode === "group" && draft.mode === "channels") Alert.alert("Use selected channels?", "Whole-group access will be replaced. Channels not selected will no longer have an explicit grant.", [{ text: "Cancel", style: "cancel" }, { text: "Save changes", onPress: () => void save() }]);
    else if (isSelf && original.role === "admin" && draft.role === "member" && draft.mode === "group") Alert.alert("Change your own role?", "You may lose the ability to manage this group.", [{ text: "Cancel", style: "cancel" }, { text: "Change role", style: "destructive", onPress: () => void save() }]);
    else void save();
  };
  return <MemberSheet title="Participant access" onClose={close}>
    <View style={styles.detailIdentity}>{person ? <PersonAvatar name={name} /> : <AgentAvatar agentId={scopes[0].member_id} size={40} />}
      <View style={styles.identity}><Text style={styles.name}>{name}</Text><Text style={styles.meta}>{isSelf ? "Your access" : person ? "Person" : "Agent · reads and replies in its channels"}</Text></View></View>
    <ParticipantAccessFields value={draft} onChange={setDraft} channels={channels} permissions={permissions} person={person} inherited={inherited} lockScope={lockScope} disabled={saving || failed} />
    {person && isPublic ? <Text style={styles.hint}>This group is public. Everyone signed in can still participate, even without an explicit membership. Admin roles remain scoped.</Text> : null}
    {failed ? <Text accessibilityRole="alert" style={styles.destructiveText}>Access may have changed. Close and reopen this participant to review the latest state before editing again.</Text> : null}
    {editable ? <Pressable accessibilityRole="button" accessibilityLabel="Save access changes" disabled={!dirty || saving || failed || (draft.mode === "channels" && !Object.keys(draft.channels).length)}
      style={[styles.primary, (!dirty || saving || failed || (draft.mode === "channels" && !Object.keys(draft.channels).length)) && styles.disabled]} onPress={submit}><Text style={styles.primaryText}>{saving ? "Saving…" : "Save changes"}</Text></Pressable> : null}
    {!dirty && !saving && !failed ? scopes.filter(scope => !scope.channel_id || original.mode !== "group").map(scope => {
      const manageable = !scope.channel_id ? permissions.groupAdmin : permissions.groupAdmin || permissions.channelIds.includes(scope.channel_id);
      if (!manageable && !(person && isSelf && scope.channel_id)) return null;
      const scopeName = scope.channel_id ? "#" + (channels.find(channel => channel.id === scope.channel_id)?.name ?? scope.channel_id) : "Whole group";
      return <Pressable key={scope.channel_id ?? "group"} accessibilityRole="button" accessibilityLabel={`${isSelf ? "Leave" : "Remove " + name + " from"} ${scopeName}`} style={styles.destructiveAction} onPress={() => onRemove(scope)}>
        <Text style={styles.destructiveText}>{isSelf ? "Leave " : "Remove from "}{scopeName}</Text>
      </Pressable>;
    }) : null}
    {onLeave && !dirty && !saving ? <Pressable accessibilityRole="button" accessibilityLabel="Leave group" style={styles.destructiveAction} onPress={onLeave}><Text style={styles.destructiveText}>Leave group</Text></Pressable> : null}
  </MemberSheet>;
}

export default function MembersScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ groupId: string; name?: string; channelId?: string }>();
  const groupId = params.groupId;
  const members = useMembers(groupId);
  const agents = useAgents();
  const groups = useGroups();
  const addMember = useAddMember(groupId);
  const removeMember = useRemoveMember(groupId);
  const [tab, setTab] = useState<"people" | "agents">("people");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member[] | null>(null);
  const username = useSession(s => s.username);
  const instanceAdmin = useSession(s => s.instanceAdmin);
  const group = (groups.data ?? []).find(g => g.id === groupId);
  const channels = group?.channels ?? [];
  const groupAdmin = !!group && (group.role === "admin" || instanceAdmin);
  const permissions: AccessPermissions = { groupAdmin, channelIds: channels.filter(channel => groupAdmin || channel.role === "admin").map(channel => channel.id) };
  const admin = groupAdmin || permissions.channelIds.length > 0;
  const users = useUsers(admin);
  const selectedChannel = channels.find(channel => channel.id === params.channelId);
  const channelFocused = !!params.channelId;
  const channelName = (id: string | null) => id ? channels.find(channel => channel.id === id)?.name ?? id : null;
  const people = (members.data ?? []).filter(scope => scope.member_type === "user");
  const agentMembers = (members.data ?? []).filter(scope => scope.member_type === "agent");
  const roster = (scopes: Member[]) => {
    const entries = new Map<string, Member[]>();
    for (const scope of scopes) entries.set(scope.member_id, [...(entries.get(scope.member_id) ?? []), scope]);
    // Keep every visible scope for the editor, even when arriving from a channel.
    return [...entries.entries()].map(([id, allScopes]) => ({ id, scopes: allScopes, visible: visibleMembershipScopes(allScopes, params.channelId) }))
      .filter(entry => entry.visible.length > 0);
  };
  const peopleGroups = roster(people), agentGroups = roster(agentMembers);
  const peopleTab = tab === "people";
  const visible = (peopleTab ? peopleGroups : agentGroups).filter(entry =>
    (entry.id + " " + (entry.scopes[0].name || "")).toLowerCase().includes(search.trim().toLowerCase()));
  const managedChannels = channels.filter(channel => permissions.channelIds.includes(channel.id));
  const canAdd = (id: string, scopes: Member[]) => {
    const existing = scopes.filter(scope => scope.member_id === id);
    if (existing.some(scope => !scope.channel_id)) return false;
    return groupAdmin || managedChannels.some(channel => !existing.some(scope => scope.channel_id === channel.id));
  };
  const addablePeople = (users.data ?? []).filter(user => !user.disabled && canAdd(user.username, people));
  const addableAgents = (agents.data ?? []).filter(agent => canAdd(agent.id, agentMembers));
  const add = (type: "user" | "agent", id: string, role: AccessRole, channelId: string | null) =>
    addMember.mutateAsync({ member_type: type, member_id: id, role, channel_id: channelId ?? undefined });
  const remove = (scope: Member) => {
    const self = scope.member_type === "user" && scope.member_id === username;
    Alert.alert(self ? "Leave this access?" : `Remove ${scope.name || scope.member_id}?`,
      `Remove ${scopeLabel(scope, channelName)} access?${group?.is_public && scope.member_type === "user" ? " Public member access will remain." : ""}`,
      [{ text: "Cancel", style: "cancel" }, { text: self ? "Leave" : "Remove", style: "destructive", onPress: () => removeMember.mutate(
        { member_type: scope.member_type, member_id: scope.member_id, channel_id: scope.channel_id },
        { onSuccess: () => setEditing(null), onError: e => toastErr("Remove failed", e) },
      ) }]);
  };
  const leave = () => Alert.alert(`Leave ${group?.name || params.name || "group"}?`,
    group?.is_public ? "Your explicit memberships and roles will be removed. Public member access remains." : "You will lose access to this group and its channels.",
    [{ text: "Cancel", style: "cancel" }, { text: "Leave group", style: "destructive", onPress: async () => {
      try { await removeMember.mutateAsync({ member_type: "user", member_id: username!, all_scopes: true }); setEditing(null); }
      catch (e) { toastErr("Leave failed", e); }
    } }]);
  const save = async (draft: AccessDraft) => {
    if (!editing) return;
    // Re-read before applying a draft so a stale sheet cannot overwrite another admin.
    const fresh = await members.refetch();
    if (!fresh.data || fresh.isError) throw new Error("Couldn't verify current access. Please reopen and try again.");
    const current = fresh.data.filter(scope => scope.member_id === editing[0].member_id && scope.member_type === editing[0].member_type);
    const signature = (scopes: Member[]) => JSON.stringify(scopes.map(scope => [scope.channel_id, scope.role]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (signature(current) !== signature(editing)) throw new Error("This participant's access changed while you were editing. Reopen to review it.");
    const participant = editing[0];
    if (participant.member_type === "user" && participant.member_id === username && !instanceAdmin && accessDraft(editing).mode === "group" && draft.mode === "channels")
      throw new Error("Another group admin must narrow your own group access.");
    const changes = planAccess(current, draft, permissions);
    await applyAccess(changes, change => change.kind === "add"
      ? add(participant.member_type, participant.member_id, change.role, change.channelId)
      : removeMember.mutateAsync({ member_type: participant.member_type, member_id: participant.member_id, channel_id: change.channelId }));
    toast("Access updated.");
  };
  const count = peopleGroups.length + agentGroups.length;
  const contextName = selectedChannel ? "#" + selectedChannel.name : params.name || group?.name || "Group";
  return <>
    <Stack.Screen options={{ title: "Participants", headerShown: true }} />
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={styles.contextTitle} numberOfLines={2}>{contextName}</Text>
        <Text style={styles.meta}>{members.isSuccess ? `${count} ${count === 1 ? "participant" : "participants"} · people and agents` : "Participant directory"}</Text>
        <SearchField value={search} onChange={setSearch} placeholder="Search participants" />
        <View style={styles.tabs}>{(["people", "agents"] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === "people" ? "People" : "Agents"} accessibilityState={{ selected: tab === value }} onPress={() => setTab(value)} style={[styles.tab, tab === value && styles.tabSelected]}>
          <Icon icon={value === "people" ? Users : Bot} size={16} color={tab === value ? colors.text : colors.faint} /><Text style={[styles.tabText, tab === value && styles.tabTextSelected]}>{value === "people" ? "People" : "Agents"} {value === "people" ? peopleGroups.length : agentGroups.length}</Text>
        </Pressable>)}</View>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.sectionRow}><Text style={styles.section}>{peopleTab ? "People" : "Agents"}</Text>
          {admin && members.isSuccess ? <Pressable accessibilityRole="button" accessibilityLabel={peopleTab ? "Add people" : "Add agents"} style={styles.addButton} onPress={() => setAdding(true)}><Text style={styles.link}>＋ {peopleTab ? "Add people" : "Add agents"}</Text></Pressable> : null}
        </View>
        {members.isLoading ? <Text style={styles.feedback}>Loading participants…</Text> : null}
        {members.isError ? <View style={styles.accessCard}><Text style={styles.hint}>Couldn't load participants.</Text><Pressable accessibilityRole="button" style={styles.backStep} onPress={() => void members.refetch()}><Text style={styles.link}>Try again</Text></Pressable></View> : null}
        {visible.length > 0 ? <View style={styles.roster}>{visible.map(entry => {
          const name = entry.scopes[0].name || entry.id;
          const self = peopleTab && entry.id === username;
          const offline = !peopleTab && agents.data?.find(agent => agent.id === entry.id)?.live === false;
          return <Pressable key={entry.id} style={styles.memberRow} accessibilityRole="button" accessibilityLabel={`Access for ${name}${self ? ", you" : ""}`}
            accessibilityValue={{ text: scopeSummary(entry.visible, channelName, peopleTab) }} onPress={() => setEditing(entry.scopes)}>
            {peopleTab ? <PersonAvatar name={name} /> : <AgentAvatar agentId={entry.id} size={36} />}
            <View style={styles.identity}><View style={styles.nameLine}><Text style={styles.name} numberOfLines={1}>{name}</Text>{self ? <Text style={styles.you}>You</Text> : null}</View>
              <Text style={styles.meta} numberOfLines={1}>{scopeSummary(entry.visible, channelName, peopleTab)}{offline ? " · Offline" : ""}</Text></View>
            <Icon icon={ChevronRight} size={16} color={colors.faint} />
          </Pressable>;
        })}</View> : members.isSuccess ? <View style={styles.emptyState}><Icon icon={peopleTab ? Users : Bot} size={28} color={colors.faint} />
          <Text style={styles.emptyTitle}>{search.trim() ? "No matching participants" : peopleTab ? "No people here yet" : "No agents here yet"}</Text>
          <Text style={styles.hint}>{search.trim() ? "Try another name or switch tabs." : admin ? "Add participants to get started." : "A group or channel admin can add participants here."}</Text>
        </View> : null}
        <Text style={styles.footerHint}>Tap a participant to review their access.{!groupAdmin && admin ? " You can manage your channels from here." : ""}</Text>
      </ScrollView>
    </View>
    {editing ? <AccessEditor scopes={editing} channels={channels} permissions={permissions} isSelf={editing[0].member_type === "user" && editing[0].member_id === username}
      instanceAdmin={instanceAdmin} isPublic={!!group?.is_public} onSave={save} onRemove={remove} onClose={() => setEditing(null)}
      onLeave={editing[0].member_type === "user" && editing[0].member_id === username && (!channelFocused || editing.some(scope => !scope.channel_id)) && !groupAdmin ? leave : undefined} /> : null}
    {admin && adding && peopleTab ? <AddPerson users={addablePeople} memberships={people} channels={managedChannels} pending={addMember.isPending}
      onAdd={(user, role, channelId) => add("user", user.username, role, channelId)} onCancel={() => setAdding(false)} allowWholeGroup={groupAdmin}
      initialChannelId={managedChannels.some(channel => channel.id === params.channelId) ? params.channelId : undefined}
      channelFocused={channelFocused} loading={users.isLoading} error={users.isError} onRetry={() => void users.refetch()} /> : null}
    {admin && adding && !peopleTab ? <AddAgent agents={addableAgents} totalAgents={agents.data?.length ?? 0} memberships={agentMembers} channels={managedChannels} pending={addMember.isPending}
      onAdd={(agent, channelId) => add("agent", agent.id, "member", channelId)} onCancel={() => setAdding(false)} allowWholeGroup={groupAdmin}
      initialChannelId={managedChannels.some(channel => channel.id === params.channelId) ? params.channelId : undefined}
      channelFocused={channelFocused} loading={agents.isLoading} error={agents.isError} onRetry={() => void agents.refetch()} /> : null}
  </>;
}
const useStyles = createThemedStyles(({ colors, surfaces }) => ({
  primary: { minHeight: 48, borderRadius: 12, backgroundColor: colors.accentSoft, borderColor: colors.accentBorder, borderWidth: 1, alignItems: "center", justifyContent: "center", padding: 12 },
  primaryText: { color: colors.a1, fontSize: typography.bodySm.fontSize, fontWeight: weight.bold },
  disabled: { opacity: 0.45 },
  check: { width: 22, height: 22, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  checked: { backgroundColor: colors.accentSoft, borderColor: colors.a1 },
  root: { flex: 1, backgroundColor: colors.bg },
  toolbar: { paddingHorizontal: 20, paddingTop: 10, gap: 8 },
  contextTitle: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: weight.bold },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, minHeight: 44 },
  searchInput: { flex: 1, color: colors.text, fontSize: typography.bodySm.fontSize, minHeight: 44, paddingVertical: 8 },
  tabs: { flexDirection: "row", backgroundColor: colors.panel, padding: 4, borderRadius: 12, marginTop: 2 },
  tab: { flex: 1, minHeight: 44, borderRadius: 9, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  tabSelected: { backgroundColor: colors.panelStrong },
  tabText: { color: colors.faint, fontSize: typography.bodySm.fontSize, fontWeight: weight.semibold },
  tabTextSelected: { color: colors.text },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 52, paddingTop: 6 },
  section: { color: colors.dim, fontSize: typography.caption.fontSize, fontWeight: weight.bold, textTransform: "uppercase", letterSpacing: 1 },
  addButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: "center" },
  roster: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 16, overflow: "hidden" },
  memberRow: { minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  identity: { flex: 1, minWidth: 0, gap: 3 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: colors.text, fontSize: typography.bodySm.fontSize, fontWeight: weight.semibold, flexShrink: 1 },
  meta: { color: colors.dim, fontSize: typography.caption.fontSize },
  you: { color: colors.a2, backgroundColor: colors.mintSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, fontSize: typography.caption.fontSize },
  avatar: { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.mintSoft, justifyContent: "center", alignItems: "center" },
  initials: { color: colors.a2, fontSize: typography.caption.fontSize, fontWeight: weight.bold },
  link: { color: colors.a1, fontSize: typography.bodySm.fontSize, fontWeight: weight.semibold },
  backdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
  sheet: { ...surfaces.sheet, maxHeight: "88%" },
  sheetContent: { gap: 12, paddingBottom: 12 },
  detailIdentity: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  accessCard: { backgroundColor: colors.panel, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 8 },
  scopeName: { color: colors.text, fontSize: typography.bodySm.fontSize, fontWeight: weight.semibold, flexShrink: 1 },
  destructiveAction: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: 8 },
  destructiveText: { color: colors.red, fontSize: typography.bodySm.fontSize, fontWeight: weight.semibold },
  optionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 56, padding: 12, borderRadius: 12, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  backStep: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, alignSelf: "flex-start" },
  emptyState: { paddingVertical: 24, alignItems: "flex-start", gap: 12 },
  emptyTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: weight.semibold },
  hint: { color: colors.dim, fontSize: typography.bodySm.fontSize, lineHeight: 21 },
  feedback: { color: colors.dim, paddingVertical: 16, fontSize: typography.bodySm.fontSize },
  footerHint: { color: colors.faint, fontSize: typography.caption.fontSize, lineHeight: 19, paddingVertical: 8 },
}));
