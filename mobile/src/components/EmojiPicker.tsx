import { ThemedInput as TextInput } from "./ThemedInput";
/* Emoji picker sheet: the curated Unicode set from @agora/core with
   keyword search and a persisted "recently used" row (usePrefs). Used to
   pick a reaction from the message long-press sheet; the caller decides
   whether a pick closes the sheet. */

import React, { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { EMOJI_CATEGORIES, EmojiEntry } from "@agora/core";
import { colors, surfaces } from "../lib/theme";
import { usePrefs } from "../state/prefs";

const COLS = 8;

/* Rows precomputed for FlatList: a header line or one grid row of ≤8. */
type Row = { key: string; header?: string; emoji?: EmojiEntry[] };

function buildRows(query: string, recent: string[]): Row[] {
  const out: Row[] = [];
  const pushCat = (name: string, list: EmojiEntry[]) => {
    if (!list.length) return;
    out.push({ key: `h-${name}`, header: name });
    for (let i = 0; i < list.length; i += COLS) {
      out.push({ key: `r-${name}-${i}`, emoji: list.slice(i, i + COLS) });
    }
  };
  if (query) {
    const hits = EMOJI_CATEGORIES.flatMap((cat) =>
      cat.emoji.filter((entry) => entry[1].includes(query)),
    ).slice(0, 64);
    pushCat("Results", hits);
    return out;
  }
  if (recent.length) pushCat("Recently used", recent.map((ch) => [ch, ""] as EmojiEntry));
  for (const cat of EMOJI_CATEGORIES) pushCat(cat.name, cat.emoji);
  return out;
}

export function EmojiPicker({
  visible,
  onPick,
  onClose,
}: {
  visible: boolean;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const recent = usePrefs((s) => s.recentEmoji);
  const rememberEmoji = usePrefs((s) => s.rememberEmoji);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => (visible ? buildRows(q, recent) : []), [q, recent, visible]);

  const close = () => {
    setQuery("");
    onClose();
  };

  const pick = (ch: string) => {
    rememberEmoji(ch);
    onPick(ch);
  };

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search emoji…"
            placeholderTextColor={colors.faint}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {rows.length === 0 ? (
            <Text style={styles.empty}>No matching emoji.</Text>
          ) : (
            <FlatList
              style={styles.list}
              data={rows}
              keyExtractor={(r) => r.key}
              keyboardShouldPersistTaps="always"
              renderItem={({ item }) =>
                item.header ? (
                  <Text style={styles.header}>{item.header}</Text>
                ) : (
                  <View style={styles.row}>
                    {item.emoji!.map(([ch]) => (
                      <Pressable key={ch} style={styles.cell} onPress={() => pick(ch)}>
                        <Text style={styles.emoji}>{ch}</Text>
                      </Pressable>
                    ))}
                  </View>
                )
              }
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    ...surfaces.sheet,
    paddingBottom: 30,
    maxHeight: "62%",
  },
  search: {
    color: colors.text,
    fontSize: 14.5,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  list: { flexGrow: 0 },
  header: {
    color: colors.faint,
    fontSize: 10.5,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingTop: 10,
    paddingBottom: 4,
  },
  row: { flexDirection: "row" },
  /* Fixed fractional width so a short last row keeps the grid geometry. */
  cell: {
    width: `${100 / COLS}%`,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    borderRadius: 8,
  },
  emoji: { fontSize: 26 },
  empty: { color: colors.dim, fontSize: 14, paddingVertical: 16, textAlign: "center" },
});
