import { ThemedInput as TextInput } from "./ThemedInput";
/* An agent-authored interactive form inside a message bubble, mirroring the
   desktop's agoFormHTML: text inputs and checkboxes over one shared state
   (meta.form_state — every member edits the same values, synced live), plus
   the agent's buttons. Checkbox taps persist immediately; typed text stays a
   local draft until its check icon (or the keyboard's return key) confirms
   it. The first button press submits the server's snapshot to the authoring
   agent and locks the form for everyone (meta.form_submitted). */

import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { useSubmitForm, useUpdateFormState } from "@agora/core";
import type { Message } from "@agora/core";
import { fmtTs } from "@agora/core";
import { colors } from "../lib/theme";
import { Icon } from "./Icon";

export function MessageForm({ message }: { message: Message }) {
  const update = useUpdateFormState();
  const submit = useSubmitForm();
  /* Unconfirmed input text, keyed by field id. Local on purpose: a
     message_update re-render must never clobber typing. Server state is
     authoritative once confirmed, so losing a draft on unmount is fine. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const form = message.meta?.form;
  if (!form || !Array.isArray(form.fields) || !Array.isArray(form.buttons)) return null;
  const state = message.meta?.form_state ?? {};
  const done = message.meta?.form_submitted;

  if (done) {
    const values = done.values ?? {};
    const button = form.buttons.find((b) => b.id === done.button_id);
    return (
      <View style={styles.form}>
        {form.fields.map((f) => (
          <View key={f.id} style={styles.doneRow}>
            <Text style={styles.doneLabel}>{f.label}</Text>
            {f.kind === "checkbox" ? (
              values[f.id] ? (
                <Icon icon={Check} size={13} color="#6ee7a0" />
              ) : (
                <Text style={styles.doneValue}>—</Text>
              )
            ) : (
              <Text style={styles.doneValue}>{String(values[f.id] || "—")}</Text>
            )}
          </View>
        ))}
        <View style={styles.doneFoot}>
          <Icon icon={Check} size={13} color="#6ee7a0" />
          <Text style={styles.doneButton}>{button?.label || done.button_id}</Text>
          <Text style={styles.doneBy}>
            by {done.by || "?"}
            {done.ts ? ` · ${fmtTs(done.ts)}` : ""}
          </Text>
        </View>
      </View>
    );
  }

  const fail = (e: unknown, fallback: string) =>
    Alert.alert("Form", e instanceof Error ? e.message : fallback);

  const dropDraft = (d: Record<string, string>, fieldId: string) => {
    const rest = { ...d };
    delete rest[fieldId];
    return rest;
  };

  const confirmField = (fieldId: string) => {
    const draft = drafts[fieldId];
    if (draft === undefined) return;
    update.mutate(
      { messageId: message.id, fieldId, value: draft },
      {
        onSuccess: () => setDrafts((d) => dropDraft(d, fieldId)),
        onError: (e) => fail(e, "Could not save the value"),
      },
    );
  };

  /* Flush unconfirmed drafts first — submit snapshots the server's state,
     so anything still local would otherwise be lost — then lock. A raced
     second press gets the server's 409; the locked view arrives with the
     message_update broadcast either way. */
  const press = async (buttonId: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      for (const [fieldId, value] of Object.entries(drafts)) {
        await update.mutateAsync({ messageId: message.id, fieldId, value });
      }
      setDrafts({});
      await submit.mutateAsync({ messageId: message.id, buttonId });
    } catch (e) {
      fail(e, "Could not submit the form");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.form}>
      {form.fields.map((f) => {
        if (f.kind === "checkbox") {
          const on = state[f.id] === true;
          return (
            <Pressable
              key={f.id}
              style={styles.checkRow}
              onPress={() =>
                update.mutate(
                  { messageId: message.id, fieldId: f.id, value: !on },
                  { onError: (e) => fail(e, "Could not update the form") },
                )
              }
              disabled={update.isPending || submitting}
            >
              <View style={[styles.checkBox, on && styles.checkBoxOn]}>
                {on ? <Icon icon={Check} size={12} color="#6ee7a0" /> : null}
              </View>
              <Text style={styles.checkLabel}>{f.label}</Text>
            </Pressable>
          );
        }
        const server = typeof state[f.id] === "string" ? (state[f.id] as string) : "";
        const draft = drafts[f.id];
        const dirty = draft !== undefined && draft !== server;
        return (
          <View key={f.id} style={styles.field}>
            <Text style={styles.fieldLabel}>{f.label}</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={draft ?? server}
                placeholder={f.placeholder || ""}
                placeholderTextColor={colors.faint}
                maxLength={2000}
                editable={!submitting}
                onChangeText={(text) =>
                  setDrafts((d) =>
                    text === server ? dropDraft(d, f.id) : { ...d, [f.id]: text },
                  )
                }
                onSubmitEditing={() => confirmField(f.id)}
              />
              {dirty ? (
                <Pressable
                  style={styles.confirmBtn}
                  onPress={() => confirmField(f.id)}
                  disabled={update.isPending || submitting}
                  hitSlop={6}
                >
                  <Icon icon={Check} size={14} color="#6ee7a0" />
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}
      <View style={styles.actions}>
        {form.buttons.map((b) => (
          <Pressable
            key={b.id}
            style={[styles.button, b.style === "primary" && styles.buttonPrimary]}
            onPress={() => press(b.id)}
            disabled={submitting}
          >
            <Text style={[styles.buttonLabel, b.style === "primary" && styles.buttonPrimaryLabel]}>
              {b.label || b.id}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    marginTop: 8,
    padding: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  field: { gap: 4 },
  fieldLabel: { color: colors.text, fontSize: 12.5, fontWeight: "600" },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  confirmBtn: {
    width: 44,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(72,187,120,0.45)",
    backgroundColor: colors.panelStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2, minHeight: 44 },
  checkBox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.panelStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: {
    borderColor: "rgba(72,187,120,0.55)",
    backgroundColor: "rgba(72,187,120,0.14)",
  },
  checkLabel: { color: colors.text, fontSize: 13, flexShrink: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 },
  button: {
    minHeight: 44,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  buttonPrimary: {
    backgroundColor: "rgba(72,187,120,0.18)",
    borderColor: "rgba(72,187,120,0.45)",
  },
  buttonLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  buttonPrimaryLabel: { color: "#6ee7a0" },
  doneRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  doneLabel: { color: colors.faint, fontSize: 12.5, fontWeight: "600" },
  doneValue: { color: colors.text, fontSize: 12.5, flexShrink: 1 },
  doneFoot: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  doneButton: { color: "#6ee7a0", fontSize: 12, fontWeight: "600" },
  doneBy: { color: colors.faint, fontSize: 12 },
});
