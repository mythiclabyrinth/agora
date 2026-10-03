/* Presentational layer of the live voice screen: orb, status line and
   mute/end controls for a given session state. The half-duplex loop logic
   stays in app/(app)/live/[channelId].tsx; splitting the view out keeps
   every visual state reachable from Storybook without a recorder. */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Headphones, Mic, MicOff } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { colors, typography, radii, space } from "../lib/theme";

export type LiveStatus = "starting" | "listening" | "recording" | "thinking" | "speaking" | "error";

const LABELS: Record<LiveStatus, string> = {
  starting: "Starting…",
  listening: "Listening — just talk",
  recording: "Recording…",
  thinking: "Thinking…",
  speaking: "Speaking — tap to interrupt",
  error: "Microphone unavailable",
};

export function LiveVoiceView({
  channelLabel,
  threadSession,
  rootSnippet,
  status,
  muted,
  muteBusy,
  meteringDb,
  onInterrupt,
  onToggleMute,
  onEnd,
}: {
  channelLabel: string;
  /** Thread-scoped session: swaps the header for the thread variant. */
  threadSession: boolean;
  rootSnippet?: string;
  status: LiveStatus;
  muted: boolean;
  muteBusy: boolean;
  /** Latest mic metering sample; drives the orb size (-60dB..0dB → 1.0..1.5). */
  meteringDb: number | null;
  onInterrupt: () => void;
  onToggleMute: () => void;
  onEnd: () => void;
}) {
  const insets = useSafeAreaInsets();

  const db = meteringDb ?? -60;
  const level = Math.max(0, Math.min(1, (db + 60) / 60));
  const active = status === "listening" || status === "recording";
  const scale = active ? 1 + level * 0.5 : 1;
  const muteDisabled = muteBusy || status === "starting" || status === "error";

  return (
    <Pressable style={[styles.root, { paddingTop: insets.top + 18 }]} onPress={onInterrupt}>
      {threadSession ? (
        <>
          <Text style={styles.channel}>Thread · # {channelLabel}</Text>
          {rootSnippet ? (
            <Text style={styles.rootSnippet} numberOfLines={2}>
              {rootSnippet}
            </Text>
          ) : null}
        </>
      ) : (
        <View style={styles.channelRow}>
          <Icon icon={Headphones} size={16} />
          <Text style={styles.channel}># {channelLabel}</Text>
        </View>
      )}
      <View style={styles.center}>
        <View style={styles.orbit}>
        <View style={styles.orbitInner} />
        <View
          style={[
            styles.orb,
            status === "recording" && styles.orbRecording,
            status === "thinking" && styles.orbThinking,
            status === "speaking" && styles.orbSpeaking,
            { transform: [{ scale }] },
          ]}
        ><Icon icon={muted ? MicOff : Mic} size={38} color={colors.onAccent} /></View>
        </View>
        {/* The Mute control already shows muted-ness; the status line only
            changes when muted actually alters what talking does (idle). */}
        <Text style={styles.status}>
          {muted && status === "listening" ? "Muted — tap Unmute to talk" : LABELS[status]}
        </Text>
        {status === "error" ? (
          <Text style={styles.errorHint}>
            Allow microphone access in Settings, then try again.
          </Text>
        ) : null}
      </View>
      <View style={[styles.controls, { marginBottom: insets.bottom + 22 }]}>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={muted ? "Unmute microphone" : "Mute microphone and finish this turn"}
          accessibilityState={{ checked: muted, disabled: muteDisabled }}
          disabled={muteDisabled}
          style={[styles.muteBtn, muted && styles.muteBtnActive, muteDisabled && styles.disabledBtn]}
          onPress={onToggleMute}
        >
          <Icon icon={muted ? Mic : MicOff} size={20} color={muted ? colors.red : colors.text} />
          <Text style={[styles.muteText, muted && styles.muteTextActive]}>
            {muted ? "Unmute" : "Mute"}
          </Text>
        </Pressable>
        <Pressable style={styles.endBtn} onPress={onEnd}>
          <Text style={styles.endText}>End</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: "center" },
  channelRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  channel: { color: colors.dim, fontSize: 14.5, fontWeight: "700" },
  rootSnippet: {
    color: colors.dim,
    fontSize: 12.5,
    marginTop: 6,
    paddingHorizontal: 36,
    textAlign: "center",
    opacity: 0.8,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.section },
  orbit: { width: 206, height: 206, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.accentBorder,
    backgroundColor: colors.accentWash, alignItems: "center", justifyContent: "center" },
  orbitInner: { position: "absolute", width: 168, height: 168, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.accentBorder },
  orb: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: colors.accent,
    opacity: 0.9,
    alignItems: "center",
    justifyContent: "center",
  },
  orbRecording: { backgroundColor: colors.red },
  orbThinking: { backgroundColor: colors.amber, opacity: 0.6 },
  orbSpeaking: { backgroundColor: colors.a1 },
  status: { color: colors.text, ...typography.title, textAlign: "center", paddingHorizontal: space.lg },
  errorHint: {
    color: colors.dim,
    fontSize: 13.5,
    textAlign: "center",
    paddingHorizontal: 40,
  },
  endBtn: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 44,
  },
  controls: { flexDirection: "row", alignItems: "center", gap: 12 },
  muteBtn: {
    minHeight: 48,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  muteBtnActive: { borderColor: colors.red },
  muteText: { color: colors.text, fontSize: 15.5, fontWeight: "700" },
  muteTextActive: { color: colors.red },
  disabledBtn: { opacity: 0.6 },
  endText: { color: colors.text, fontSize: 15.5, fontWeight: "700" },
});
