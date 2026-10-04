import React, { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Check, ChevronDown } from "lucide-react-native";
import { AnchoredMenu } from "./AnchoredMenu";
import { Icon } from "./Icon";
import { ResponsiveText as Text } from "./ResponsiveText";
import { RoleDropdown } from "./RoleDropdown";
import type { AccessDraft, AccessPermissions } from "../lib/participantAccess";
import { typography, weight } from "../lib/theme";
import { createThemedStyles, useAppTheme } from "../lib/useTheme";

/** The route determines the roster, not what the caller may administer. */
export function ParticipantAccessFields({ value, onChange, channels, permissions, person = true, inherited = false, lockScope = false, disabled = false }: {
  value: AccessDraft; onChange: (value: AccessDraft) => void;
  channels: { id: string; name: string }[]; permissions: AccessPermissions;
  person?: boolean; inherited?: boolean; lockScope?: boolean; disabled?: boolean;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Keep the sheet's height and the trigger's position stable while choosing.
  // Done applies the selection; dismissing the menu leaves the draft untouched.
  const [pendingChannels, setPendingChannels] = useState(value.channels);
  const anchor = useRef<View>(null);
  const canEdit = (id: string) => !disabled && !inherited && (permissions.groupAdmin || permissions.channelIds.includes(id));
  const selected = Object.keys(value.channels);
  const options = channels.filter(channel => canEdit(channel.id));
  const toggle = (id: string) => {
    if (!canEdit(id)) return;
    setPendingChannels(current => {
      const next = { ...current };
      if (next[id]) delete next[id]; else next[id] = "member";
      return next;
    });
  };
  return <View style={styles.fields}>
    <Text style={styles.label}>Access</Text>
    {permissions.groupAdmin && !lockScope ? <View style={styles.segment}>
      {(["group", "channels"] as const).map(mode => <Pressable key={mode} accessibilityRole="radio" accessibilityLabel={mode === "group" ? "Entire group" : "Selected channels"}
        accessibilityState={{ checked: value.mode === mode, disabled }} disabled={disabled}
        onPress={() => onChange({ ...value, mode })} style={[styles.segmentItem, value.mode === mode && styles.active]}>
        <Text style={[styles.segmentText, value.mode === mode && styles.activeText]}>{mode === "group" ? "Entire group" : "Selected channels"}</Text>
      </Pressable>)}
    </View> : <Text style={styles.title}>{value.mode === "group" ? "Entire group" : "Selected channels"}</Text>}
    {value.mode === "group" ? <>
      <Text style={styles.hint}>{inherited ? "Inherited from the group. Only a group admin can change this access." : "Includes all current and future channels. One role applies everywhere."}</Text>
      {person ? <View style={styles.roleRow}><Text style={styles.title}>Group role</Text><RoleDropdown label="Group role" value={value.role}
        disabled={disabled || !permissions.groupAdmin} onChange={role => onChange({ ...value, role })} /></View> : null}
      {lockScope && permissions.groupAdmin ? <Text style={styles.hint}>Ask another group admin to narrow your own access.</Text> : null}
    </> : <>
      {options.length > 0 ? <Pressable ref={anchor} accessibilityRole="button" accessibilityLabel="Select channels" accessibilityState={{ expanded: open, disabled }} disabled={disabled}
        style={styles.select} onPress={() => { setSearch(""); setPendingChannels(value.channels); setOpen(true); }}>
        <Text style={styles.title}>{selected.length ? `${selected.length} channel${selected.length === 1 ? "" : "s"} selected` : "Select channels"}</Text><Icon icon={ChevronDown} size={17} color={colors.a1} />
      </Pressable> : null}
      {open ? <AnchoredMenu anchor={anchor} label="Channels" minWidth={280} menuHeight={Math.min(340, options.length * 48 + (options.length > 5 ? 44 : 0) + 54)} onClose={() => setOpen(false)}>
        {options.length > 5 ? <TextInput accessibilityLabel="Search channels" placeholder="Search channels" placeholderTextColor={colors.faint} value={search} onChangeText={setSearch} autoCapitalize="none" style={styles.search} /> : null}
        {options.filter(channel => channel.name.toLowerCase().includes(search.trim().toLowerCase())).map(channel => <Pressable key={channel.id}
          accessibilityRole="checkbox" accessibilityLabel={`Select #${channel.name}`} accessibilityState={{ checked: !!pendingChannels[channel.id] }} onPress={() => toggle(channel.id)} style={styles.option}>
          <Text style={styles.title}>#{channel.name}</Text><View style={[styles.check, !!pendingChannels[channel.id] && styles.checked]}>{pendingChannels[channel.id] ? <Icon icon={Check} size={14} color={colors.a1} /> : null}</View>
        </Pressable>)}
        {!options.some(channel => channel.name.toLowerCase().includes(search.trim().toLowerCase())) ? <Text style={styles.hint}>No matching channels.</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Done selecting channels" style={styles.done} onPress={() => { onChange({ ...value, channels: pendingChannels }); setOpen(false); }}><Text style={styles.activeText}>Done · {Object.keys(pendingChannels).length} selected</Text></Pressable>
      </AnchoredMenu> : null}
      {selected.length > 0 ? <View style={styles.selected}>
        <ScrollView testID="selected-channel-roles" accessibilityLabel="Selected channel access" style={styles.selectedScroll} contentContainerStyle={styles.selectedContent}
          nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator bounces={false}>
        {selected.map(id => <View key={id} style={styles.roleRow}>
          <View style={styles.identity}><Text style={styles.title}>#{channels.find(channel => channel.id === id)?.name ?? id}</Text>
            {!canEdit(id) ? <Text style={styles.hint}>View only</Text> : null}</View>
          {person ? <RoleDropdown label={`Role for #${channels.find(channel => channel.id === id)?.name ?? id}`} value={value.channels[id]} disabled={!canEdit(id)}
            onChange={role => onChange({ ...value, channels: { ...value.channels, [id]: role } })} /> : <Text style={styles.hint}>Can participate</Text>}
        </View>)}
        </ScrollView>
        {selected.length > 3 ? <Text style={styles.scrollHint}>Scroll to review all {selected.length} channels</Text> : null}
      </View> : <Text style={styles.hint}>Choose the channels this participant can access.</Text>}
      {!permissions.groupAdmin ? <Text style={styles.hint}>You can change access only for channels you administer.</Text> : null}
    </>}
    {person && !inherited ? <Text style={styles.hint}>Members can participate. Admins can also manage access within their group or channel.</Text> : null}
  </View>;
}
const useStyles = createThemedStyles(({ colors }) => ({
  fields: { gap: 12 }, label: { color: colors.dim, ...typography.meta },
  title: { color: colors.text, ...typography.bodySm, fontWeight: weight.semibold, flexShrink: 1 },
  hint: { color: colors.dim, ...typography.caption, lineHeight: 19 },
  segment: { flexDirection: "row", padding: 4, borderRadius: 12, backgroundColor: colors.panel },
  segmentItem: { flex: 1, minHeight: 44, padding: 8, borderRadius: 9, justifyContent: "center", alignItems: "center" },
  segmentText: { color: colors.dim, ...typography.bodySm, fontWeight: weight.semibold },
  active: { backgroundColor: colors.accentSoft }, activeText: { color: colors.a1, ...typography.bodySm, fontWeight: weight.semibold },
  select: { minHeight: 48, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.panel, borderRadius: 12, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  selected: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" },
  selectedScroll: { maxHeight: 224 }, selectedContent: { paddingHorizontal: 12 },
  scrollHint: { color: colors.faint, ...typography.caption, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  roleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, gap: 12 }, identity: { flex: 1, gap: 3 },
  option: { minHeight: 48, padding: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  check: { width: 22, height: 22, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  checked: { borderColor: colors.a1, backgroundColor: colors.accentSoft },
  search: { minHeight: 44, color: colors.text, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  done: { minHeight: 44, alignItems: "center", justifyContent: "center", borderTopWidth: 1, borderTopColor: colors.border },
}));
