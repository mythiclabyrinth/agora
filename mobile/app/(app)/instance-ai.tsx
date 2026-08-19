/* Instance-admin AI & voice settings (parity with the web AI & voice panel). */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import {
  useInstanceAi,
  useMe,
  useTestInstanceAi,
  useUpdateInstanceAi,
  type InstanceAiSettings,
  type InstanceAiUpdate,
} from "@agora/core";
import { toast, toastErr } from "../../src/components/Toast";
import { colors } from "../../src/lib/theme";

function sourceLabel(source: string): string {
  switch (source) {
    case "config": return "saved in instance settings";
    case "env": return "from server environment";
    case "default": return "default";
    default: return "not set";
  }
}

function VoiceBlock({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();
  const test = useTestInstanceAi();
  const [key, setKey] = useState("");
  const [stt, setStt] = useState(data.stt_model.value);
  const [tts, setTts] = useState(data.tts_model.value);
  const [voice, setVoice] = useState(data.tts_voice.value);

  useEffect(() => {
    setStt(data.stt_model.value);
    setTts(data.tts_model.value);
    setVoice(data.tts_voice.value);
    setKey("");
  }, [data]);

  const save = (patch: NonNullable<InstanceAiUpdate["voice"]>) => {
    update.mutate({ voice: patch }, {
      onSuccess: () => toast("Voice settings saved"),
      onError: (e) => toastErr("Couldn't save voice settings", e as Error),
    });
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Voice</Text>
          <Text style={styles.meta}>
            Provider {data.provider} · {data.available ? "available" : "off"}
          </Text>
        </View>
        <Switch
          value={data.enabled}
          onValueChange={(enabled) => save({ enabled })}
        />
      </View>
      <Text style={styles.hint}>
        Voice notes, speak-aloud, and live voice. Endpoints are fixed (OpenAI).
      </Text>
      <Text style={styles.label}>API key</Text>
      <Text style={styles.meta}>
        {data.api_key.configured
          ? `${data.api_key.hint} · ${sourceLabel(data.api_key.source)}`
          : sourceLabel(data.api_key.source)}
      </Text>
      <TextInput
        style={styles.input}
        value={key}
        onChangeText={setKey}
        placeholder={data.api_key.configured ? "replace key…" : "sk-…"}
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <View style={styles.rowBtns}>
        <Pressable
          style={[styles.btn, styles.btnPrimary, (!key.trim() || update.isPending) && styles.btnDisabled]}
          disabled={!key.trim() || update.isPending}
          onPress={() => { save({ api_key: key.trim() }); setKey(""); }}
        >
          <Text style={styles.btnPrimaryText}>Save key</Text>
        </Pressable>
        {data.api_key.source === "config" ? (
          <Pressable
            style={[styles.btn, styles.btnDanger]}
            disabled={update.isPending}
            onPress={() => save({ clear_key: true })}
          >
            <Text style={styles.btnDangerText}>Clear saved</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.label}>STT model</Text>
      <TextInput style={styles.input} value={stt} onChangeText={setStt} autoCapitalize="none" />
      <Text style={styles.label}>TTS model</Text>
      <TextInput style={styles.input} value={tts} onChangeText={setTts} autoCapitalize="none" />
      <Text style={styles.label}>TTS voice</Text>
      <TextInput style={styles.input} value={voice} onChangeText={setVoice} autoCapitalize="none" />
      <View style={styles.rowBtns}>
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          disabled={update.isPending}
          onPress={() => save({
            stt_model: stt.trim(),
            tts_model: tts.trim(),
            tts_voice: voice.trim(),
          })}
        >
          <Text style={styles.btnPrimaryText}>Save models</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, (!data.api_key.configured || test.isPending) && styles.btnDisabled]}
          disabled={!data.api_key.configured || test.isPending}
          onPress={() => test.mutate("voice", {
            onSuccess: () => toast("OpenAI key works"),
            onError: (e) => toastErr("Voice test failed", e as Error),
          })}
        >
          <Text style={styles.btnText}>{test.isPending ? "Testing…" : "Test connection"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SearchBlock({ data }: { data: InstanceAiSettings["search"] }) {
  const update = useUpdateInstanceAi();
  const test = useTestInstanceAi();
  const [key, setKey] = useState("");
  const [model, setModel] = useState(data.model.value);

  useEffect(() => {
    setModel(data.model.value);
    setKey("");
  }, [data]);

  const save = (patch: NonNullable<InstanceAiUpdate["search"]>) => {
    update.mutate({ search: patch }, {
      onSuccess: () => toast("Ask AI settings saved"),
      onError: (e) => toastErr("Couldn't save Ask AI settings", e as Error),
    });
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Ask AI</Text>
          <Text style={styles.meta}>
            Provider {data.provider} · {data.available ? "available" : "off"}
          </Text>
        </View>
        <Switch
          value={data.enabled}
          onValueChange={(enabled) => save({ enabled })}
        />
      </View>
      <Text style={styles.hint}>
        Cited answers over search hits. Plain search needs no key. Endpoints are fixed (Anthropic).
      </Text>
      <Text style={styles.label}>API key</Text>
      <Text style={styles.meta}>
        {data.api_key.configured
          ? `${data.api_key.hint} · ${sourceLabel(data.api_key.source)}`
          : sourceLabel(data.api_key.source)}
      </Text>
      <TextInput
        style={styles.input}
        value={key}
        onChangeText={setKey}
        placeholder={data.api_key.configured ? "replace key…" : "sk-ant-…"}
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <View style={styles.rowBtns}>
        <Pressable
          style={[styles.btn, styles.btnPrimary, (!key.trim() || update.isPending) && styles.btnDisabled]}
          disabled={!key.trim() || update.isPending}
          onPress={() => { save({ api_key: key.trim() }); setKey(""); }}
        >
          <Text style={styles.btnPrimaryText}>Save key</Text>
        </Pressable>
        {data.api_key.source === "config" ? (
          <Pressable
            style={[styles.btn, styles.btnDanger]}
            disabled={update.isPending}
            onPress={() => save({ clear_key: true })}
          >
            <Text style={styles.btnDangerText}>Clear saved</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.label}>Model</Text>
      <TextInput style={styles.input} value={model} onChangeText={setModel} autoCapitalize="none" />
      <Text style={styles.meta}>
        Suggested: {(data.suggested_models || []).join(", ")}
      </Text>
      <View style={styles.rowBtns}>
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          disabled={update.isPending}
          onPress={() => save({ model: model.trim() })}
        >
          <Text style={styles.btnPrimaryText}>Save model</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, (!data.api_key.configured || test.isPending) && styles.btnDisabled]}
          disabled={!data.api_key.configured || test.isPending}
          onPress={() => test.mutate("search", {
            onSuccess: () => toast("Anthropic key works"),
            onError: (e) => toastErr("Ask AI test failed", e as Error),
          })}
        >
          <Text style={styles.btnText}>{test.isPending ? "Testing…" : "Test connection"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function InstanceAiScreen() {
  const me = useMe();
  const isAdmin = me.data?.instance_admin === true;
  const q = useInstanceAi(isAdmin);

  if (me.isSuccess && !isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: "AI & voice", headerShown: true }} />
        <View style={[styles.root, styles.content]}>
          <Text style={styles.hint}>Instance admin access required.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "AI & voice", headerShown: true }} />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.hint}>
          Configure voice transcription/speech and Ask AI for this Agora.
          Clearing a saved key falls back to the server environment.
        </Text>
        {q.isLoading ? <ActivityIndicator color={colors.dim} /> : null}
        {q.isError ? <Text style={styles.hint}>Couldn&apos;t load AI settings.</Text> : null}
        {q.data ? (
          <>
            <VoiceBlock data={q.data.voice} />
            <SearchBlock data={q.data.search} />
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  hint: { color: colors.dim, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardTitle: { color: colors.text, fontWeight: "700", fontSize: 16 },
  meta: { color: colors.dim, fontSize: 12, lineHeight: 17 },
  label: { color: colors.dim, fontSize: 12, fontWeight: "600", marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  rowBtns: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  btn: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  btnPrimary: { backgroundColor: colors.text, borderColor: colors.text },
  btnPrimaryText: { color: colors.bg, fontWeight: "700", fontSize: 13 },
  btnText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  btnDanger: { borderColor: colors.red },
  btnDangerText: { color: colors.red, fontWeight: "600", fontSize: 13 },
  btnDisabled: { opacity: 0.4 },
});
