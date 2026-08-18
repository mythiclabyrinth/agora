/* An agent-authored interactive table inside a message bubble. Shared cell
   state lives in meta.table_state; typing stays a local draft until the
   keyboard return key (or the check icon) confirms it. A row action locks
   only that row; a table-level button locks every still-unlocked row. */

import React, { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Check } from "lucide-react-native";
import {
  useActOnTableRow,
  useSubmitTable,
  useUpdateTableCell,
  fmtTs,
  type Message,
  type MessageTableColumn,
} from "@agora/core";
import { colors } from "../lib/theme";
import {
  ACTION_COL,
  MAX_COL,
  MIN_COL,
  columnWidthsFromStrings,
} from "../lib/tableLayout";
import { Icon } from "./Icon";

function cellKey(rowId: string, colId: string) {
  return `${rowId}:${colId}`;
}

function displayValue(v: string | number | undefined): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

function parseCommitValue(col: MessageTableColumn, draft: string): string | number {
  if (col.kind === "number") {
    const trimmed = draft.trim();
    if (trimmed === "") return "";
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : draft;
  }
  return draft;
}

export function MessageTable({ message }: { message: Message }) {
  const update = useUpdateTableCell();
  const act = useActOnTableRow();
  const submit = useSubmitTable();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Inside a shrink-to-fit bubble nothing gives ScrollView a definite width,
  // so measure the bubble's inner width and cap the table to it.
  const [width, setWidth] = useState<number>();

  const table = message.meta?.table;
  const state = message.meta?.table_state ?? {};
  const rowLocks = message.meta?.table_rows ?? {};
  const tableDone = message.meta?.table_submitted ?? null;
  const columns = table && Array.isArray(table.columns) ? table.columns : [];
  const rows = table && Array.isArray(table.rows) ? table.rows : [];
  const buttons = table && Array.isArray(table.buttons) ? table.buttons : [];
  const tableLocked = !!tableDone;

  const colWidths = useMemo(() => {
    const head = columns.map((c) => c.label);
    const body = rows.map((row) => {
      const values = state[row.id] ?? row.cells ?? {};
      return columns.map((c) => displayValue(values[c.id]));
    });
    const estimated = columnWidthsFromStrings(head, body);
    return columns.map((c, i) => {
      if (typeof c.width === "number" && c.width > 0) {
        return Math.ceil(Math.min(Math.max(c.width, MIN_COL), MAX_COL));
      }
      return estimated[i] ?? MIN_COL;
    });
  }, [columns, rows, state]);

  if (!table || columns.length === 0 || rows.length === 0) return null;

  const fail = (e: unknown, fallback: string) =>
    Alert.alert("Table", e instanceof Error ? e.message : fallback);

  const dropDraft = (d: Record<string, string>, key: string) => {
    const rest = { ...d };
    delete rest[key];
    return rest;
  };

  const confirmCell = (rowId: string, col: MessageTableColumn) => {
    const key = cellKey(rowId, col.id);
    const draft = drafts[key];
    if (draft === undefined) return;
    update.mutate(
      { messageId: message.id, rowId, columnId: col.id, value: parseCommitValue(col, draft) },
      {
        onSuccess: () => setDrafts((d) => dropDraft(d, key)),
        onError: (e) => fail(e, "Could not save the value"),
      },
    );
  };

  const flushDrafts = async (rowId?: string) => {
    const candidates = Object.entries(drafts).filter(([key]) =>
      rowId ? key.startsWith(`${rowId}:`) : true,
    );
    // Locked-row drafts can never persist (409); drop them so they don't
    // abort a table-level submit while still flushing unlocked cells.
    const stale: string[] = [];
    const pending: [string, string][] = [];
    for (const [key, value] of candidates) {
      const rid = key.split(":")[0];
      if (rid && rowLocks[rid]) {
        stale.push(key);
        continue;
      }
      pending.push([key, value]);
    }
    for (const [key, value] of pending) {
      const [rid, columnId] = key.split(":");
      const col = columns.find((c) => c.id === columnId);
      if (!rid || !col) continue;
      await update.mutateAsync({
        messageId: message.id,
        rowId: rid,
        columnId: col.id,
        value: parseCommitValue(col, value),
      });
    }
    setDrafts((d) => {
      let next = d;
      for (const [key] of pending) next = dropDraft(next, key);
      for (const key of stale) next = dropDraft(next, key);
      return next;
    });
  };

  const pressRow = (rowId: string, actionId: string) => {
    // Keep the pressed button enabled for styling, but don't re-POST.
    if (busy || tableLocked || !!rowLocks[rowId]) return;
    setBusy(true);
    void (async () => {
      try {
        await flushDrafts(rowId);
        await act.mutateAsync({ messageId: message.id, rowId, actionId });
      } catch (e) {
        fail(e, "Could not run the action");
      } finally {
        setBusy(false);
      }
    })();
  };

  const pressTable = async (buttonId: string) => {
    if (busy || tableLocked) return;
    setBusy(true);
    try {
      await flushDrafts();
      await submit.mutateAsync({ messageId: message.id, buttonId });
    } catch (e) {
      fail(e, "Could not submit the table");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        style={[styles.scroll, width ? { maxWidth: width } : null]}
      >
        <View>
          <View style={[styles.tr, styles.thead]}>
            {columns.map((c, i) => (
              <Text key={c.id} style={[styles.cell, styles.headCell, { width: colWidths[i] }]}>
                {c.label}
              </Text>
            ))}
            <Text style={[styles.cell, styles.headCell, { width: ACTION_COL }]}>Actions</Text>
          </View>
          {rows.map((row) => {
            const lock = rowLocks[row.id];
            const rowLocked = !!lock || tableLocked;
            const values =
              lock?.values ||
              (tableDone?.rows && tableDone.rows[row.id]) ||
              state[row.id] ||
              row.cells ||
              {};
            return (
              <View key={row.id} style={styles.tr}>
                  {columns.map((col, i) => {
                  const server = displayValue(values[col.id]);
                  if (rowLocked || col.kind === "readonly") {
                    return (
                      <TextInput
                        key={col.id}
                        style={[
                          styles.cell,
                          styles.input,
                          styles.locked,
                          { width: colWidths[i] },
                        ]}
                        value={server || "—"}
                        editable={false}
                      />
                    );
                  }
                  const key = cellKey(row.id, col.id);
                  const draft = drafts[key];
                  const dirty = draft !== undefined && draft !== server;
                  return (
                    <View key={col.id} style={[styles.editCell, { width: colWidths[i] }]}>
                      <TextInput
                        style={[styles.cell, styles.input, { flex: 1 }]}
                        value={draft ?? server}
                        editable={!busy}
                        keyboardType={col.kind === "number" ? "numeric" : "default"}
                        maxLength={2000}
                        onChangeText={(text) =>
                          setDrafts((d) =>
                            text === server ? dropDraft(d, key) : { ...d, [key]: text },
                          )
                        }
                        onSubmitEditing={() => confirmCell(row.id, col)}
                      />
                      {dirty ? (
                        <Pressable
                          style={styles.confirmBtn}
                          onPress={() => confirmCell(row.id, col)}
                          disabled={update.isPending || busy}
                          hitSlop={6}
                        >
                          <Icon icon={Check} size={14} color="#6ee7a0" />
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })}
                <View style={[styles.actionsCell, { width: ACTION_COL }]}>
                  {(row.actions || []).map((a) => {
                    const pressed = lock?.action_id === a.id;
                    const disabled = busy || tableLocked || (!!lock && !pressed);
                    return (
                      <Pressable
                        key={a.id}
                        style={[
                          styles.button,
                          a.style === "primary" && styles.buttonPrimary,
                          pressed && styles.buttonPressed,
                          disabled && !pressed && styles.buttonDisabled,
                        ]}
                        onPress={() => pressRow(row.id, a.id)}
                        disabled={disabled}
                      >
                        <Text
                          style={[
                            styles.buttonLabel,
                            (a.style === "primary" || pressed) && styles.buttonPrimaryLabel,
                          ]}
                          numberOfLines={1}
                        >
                          {a.label || a.id}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
      {buttons.length > 0 ? (
        <View style={styles.footer}>
          {buttons.map((b) => {
            const pressed = tableDone?.button_id === b.id;
            const disabled = busy || (tableLocked && !pressed);
            return (
              <Pressable
                key={b.id}
                style={[
                  styles.button,
                  b.style === "primary" && styles.buttonPrimary,
                  pressed && styles.buttonPressed,
                  disabled && !pressed && styles.buttonDisabled,
                ]}
                onPress={() => void pressTable(b.id)}
                disabled={disabled}
              >
                <Text
                  style={[
                    styles.buttonLabel,
                    (b.style === "primary" || pressed) && styles.buttonPrimaryLabel,
                  ]}
                >
                  {b.label || b.id}
                </Text>
              </Pressable>
            );
          })}
          {tableDone ? (
            <Text style={styles.doneBy}>
              by {tableDone.by || "?"}
              {tableDone.ts ? ` · ${fmtTs(tableDone.ts)}` : ""}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 8,
    padding: 10,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
    alignSelf: "stretch",
  },
  scroll: {
    alignSelf: "flex-start",
  },
  thead: { backgroundColor: colors.panelStrong },
  tr: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    alignItems: "center",
  },
  cell: {
    color: colors.text,
    fontSize: 13.5,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  headCell: { fontWeight: "700", color: colors.faint },
  input: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingVertical: 4,
    marginVertical: 2,
  },
  locked: {
    color: colors.faint,
    backgroundColor: "transparent",
    borderColor: "transparent",
  },
  editCell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingRight: 4,
  },
  confirmBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(72,187,120,0.45)",
    backgroundColor: colors.panelStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  actionsCell: {
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
    justifyContent: "center",
  },
  footer: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  button: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  buttonPrimary: {
    backgroundColor: "rgba(72,187,120,0.18)",
    borderColor: "rgba(72,187,120,0.45)",
  },
  buttonPressed: {
    backgroundColor: "rgba(72,187,120,0.22)",
    borderColor: "rgba(72,187,120,0.55)",
  },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { color: colors.text, fontSize: 12.5, fontWeight: "600" },
  buttonPrimaryLabel: { color: "#6ee7a0" },
  doneBy: { color: colors.faint, fontSize: 12 },
});
