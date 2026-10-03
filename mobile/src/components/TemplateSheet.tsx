import { ThemedInput as TextInput } from "./ThemedInput";
/* Message templates: a bottom sheet matching the composer's "Talk to" and
   attach sheets. One Modal holds both views (list ⇄ editor) — presenting a
   second Modal while this one dismisses is silently dropped on iOS. */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Pencil, Plus, Trash2, X } from "lucide-react-native";
import {
  MAX_MESSAGE_CHARS,
  MAX_TEMPLATE_LABEL_CHARS,
  useCreateTemplate,
  useDeleteTemplate,
  useTemplates,
  useUpdateTemplate,
  type MessageTemplate,
} from "@agora/core";
import { colors, surfaces } from "../lib/theme";
import { Icon } from "./Icon";

function alertErr(title: string, error: unknown) {
  Alert.alert(title, error instanceof Error ? error.message : String(error));
}

export function TemplateSheet({ groupId, visible, draft, onChoose, onClose }: {
  groupId: string;
  visible: boolean;
  /** Current draft — prefills a new template ("save what I just typed"). */
  draft: string;
  onChoose: (text: string) => void;
  onClose: () => void;
}) {
  const templates = useTemplates(groupId);
  const create = useCreateTemplate(groupId);
  const update = useUpdateTemplate(groupId);
  const remove = useDeleteTemplate(groupId);
  /* "new" = the editor is open on an unsaved template. */
  const [editing, setEditing] = useState<MessageTemplate | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");

  /* Reopening the sheet always lands on the list, never a stale editor. */
  useEffect(() => {
    if (!visible) setEditing(null);
  }, [visible]);

  const begin = (item: MessageTemplate | "new") => {
    setEditing(item);
    setLabel(item === "new" ? "" : item.label);
    setText(item === "new" ? draft : item.text);
  };

  const save = async () => {
    if (!text.trim()) return;
    try {
      if (editing === "new") await create.mutateAsync({ label, text });
      else if (editing) await update.mutateAsync({ id: editing.id, label, text });
      setEditing(null);
    } catch (e) {
      alertErr("Couldn't save template", e);
    }
  };

  const confirmDelete = (item: MessageTemplate) =>
    Alert.alert("Delete template?", item.label, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void remove.mutateAsync(item.id)
          .catch(e => alertErr("Couldn't delete template", e)),
      },
    ]);

  const saving = create.isPending || update.isPending;
  const dismiss = editing ? () => setEditing(null) : onClose;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={dismiss}>
      <KeyboardAvoidingView
        style={s.keyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Backdrop taps close the list, but not a half-written template. */}
        <Pressable style={s.backdrop} onPress={editing ? undefined : onClose}>
          <Pressable testID="template-sheet" style={s.sheet} onPress={() => {}}>
            <View style={s.head}>
              <Text style={s.title}>
                {editing ? (editing === "new" ? "New template" : "Edit template") : "Templates"}
              </Text>
              <Pressable onPress={dismiss} hitSlop={8} accessibilityLabel="Close templates">
                <Icon icon={X} size={20} />
              </Pressable>
            </View>
            {editing ? (
              <>
                <ScrollView
                  style={s.editor}
                  contentContainerStyle={s.editorContent}
                  keyboardShouldPersistTaps="handled"
                >
                  <Text style={s.fieldLabel}>Label</Text>
                  <TextInput
                    value={label}
                    onChangeText={setLabel}
                    maxLength={MAX_TEMPLATE_LABEL_CHARS}
                    placeholder="Optional label"
                    placeholderTextColor={colors.faint}
                    style={s.input}
                  />
                  <Text style={s.fieldLabel}>Message</Text>
                  <TextInput
                    value={text}
                    onChangeText={setText}
                    maxLength={MAX_MESSAGE_CHARS}
                    multiline
                    placeholder="Message text"
                    placeholderTextColor={colors.faint}
                    style={[s.input, s.body]}
                  />
                </ScrollView>
                <View style={s.actions}>
                  <Pressable style={s.cancel} onPress={() => setEditing(null)}>
                    <Text style={s.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[s.save, (!text.trim() || saving) && s.off]}
                    disabled={!text.trim() || saving}
                    onPress={() => void save()}
                  >
                    <Text style={s.saveText}>Save</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Pressable style={s.add} onPress={() => begin("new")}>
                  <Icon icon={Plus} size={18} color={colors.a1} />
                  <Text style={s.addText}>Add template</Text>
                </Pressable>
                {templates.isLoading ? (
                  <ActivityIndicator color={colors.dim} style={s.status} />
                ) : templates.isError ? (
                  <View style={s.status}>
                    <Text style={s.error}>Couldn’t load templates.</Text>
                    <Pressable onPress={() => void templates.refetch()}>
                      <Text style={s.retry}>Try again</Text>
                    </Pressable>
                  </View>
                ) : templates.data?.length ? (
                  <ScrollView style={s.list}>
                    {templates.data.map(item => (
                      <View key={item.id} style={s.row}>
                        <Pressable
                          style={s.choose}
                          accessibilityLabel={`Use template ${item.label}`}
                          onPress={() => onChoose(item.text)}
                        >
                          <Text style={s.rowTitle} numberOfLines={1}>{item.label}</Text>
                          <Text style={s.preview} numberOfLines={2}>{item.text}</Text>
                        </Pressable>
                        <Pressable
                          hitSlop={7}
                          accessibilityLabel={`Edit template ${item.label}`}
                          onPress={() => begin(item)}
                        >
                          <Icon icon={Pencil} size={17} />
                        </Pressable>
                        <Pressable
                          hitSlop={7}
                          accessibilityLabel={`Delete template ${item.label}`}
                          onPress={() => confirmDelete(item)}
                        >
                          <Icon icon={Trash2} size={17} color={colors.red} />
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                ) : (
                  <Text style={s.empty}>No templates yet.</Text>
                )}
              </>
            )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  keyboard: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,.58)", justifyContent: "flex-end" },
  sheet: {
    ...surfaces.sheet,
    paddingBottom: 32,
    maxHeight: "78%",
  },
  head: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  add: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  addText: { color: colors.a1, fontSize: 15, fontWeight: "700" },
  list: { maxHeight: 420 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  choose: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  preview: { color: colors.dim, fontSize: 13, marginTop: 3 },
  empty: { color: colors.dim, textAlign: "center", padding: 28 },
  status: { padding: 28, alignItems: "center", gap: 8 },
  error: { color: colors.red },
  retry: { color: colors.a1, fontWeight: "700" },
  editor: { flexShrink: 1 },
  editorContent: { paddingBottom: 2 },
  fieldLabel: { color: colors.dim, fontSize: 12, fontWeight: "700", marginTop: 8, marginBottom: 5 },
  input: {
    color: colors.text,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    padding: 11,
  },
  body: { minHeight: 150, maxHeight: 240, textAlignVertical: "top" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 14 },
  cancel: { paddingVertical: 10, paddingHorizontal: 16 },
  cancelText: { color: colors.dim, fontWeight: "700" },
  save: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  saveText: { color: colors.onAccent, fontWeight: "800" },
  off: { opacity: 0.45 },
});
