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
  useCompleteCodexOauth,
  useDisconnectCodexOauth,
  useInstanceAi,
  useMe,
  useStartCodexOauth,
  useTestInstanceAi,
  useUpdateInstanceAi,
  type InstanceAiSettings,
  type InstanceAiUpdate,
} from "@agora/core";
import { toast, toastErr } from "../../src/components/Toast";
import { colors } from "../../src/lib/theme";
import * as Linking from "expo-linking";

const override = (f: { value: string; source: string }) =>
  f.source === "config" ? f.value : "";

const inherited = (f: { value: string; source: string }) =>
  `${f.value} (${f.source === "env" ? "from env" : "default"})`;

function sourceLabel(source: string): string {
  switch (source) {
    case "config": return "saved in instance settings";
    case "env": return "from server environment";
    case "default": return "default";
    default: return "not set";
  }
}

function VoiceFeatures({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();
  const [stt, setStt] = useState(override(data.stt_model));
  const [tts, setTts] = useState(override(data.tts_model));
  const [voice, setVoice] = useState(override(data.tts_voice));

  useEffect(() => {
    setStt(override(data.stt_model));
    setTts(override(data.tts_model));
    setVoice(override(data.tts_voice));
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
            OpenAI · {data.available ? "available" : "off"}
          </Text>
        </View>
        <Switch value={data.enabled} onValueChange={(enabled) => save({ enabled })} />
      </View>
      {!data.available && data.enabled ? (
        <Text style={styles.hint}>Add an OpenAI API key under Credentials.</Text>
      ) : null}
      <Text style={styles.label}>STT model</Text>
      <TextInput style={styles.input} value={stt} onChangeText={setStt} autoCapitalize="none"
        placeholder={inherited(data.stt_model)} placeholderTextColor={colors.faint} />
      <Text style={styles.label}>TTS model</Text>
      <TextInput style={styles.input} value={tts} onChangeText={setTts} autoCapitalize="none"
        placeholder={inherited(data.tts_model)} placeholderTextColor={colors.faint} />
      <Text style={styles.label}>TTS voice</Text>
      <TextInput style={styles.input} value={voice} onChangeText={setVoice} autoCapitalize="none"
        placeholder={inherited(data.tts_voice)} placeholderTextColor={colors.faint} />
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
    </View>
  );
}

function SearchFeatures({ data }: { data: InstanceAiSettings["search"] }) {
  const update = useUpdateInstanceAi();
  const [provider, setProvider] = useState(data.provider);
  const modelField = data.models?.[provider as "anthropic" | "openai" | "codex"] || data.model;

  useEffect(() => { setProvider(data.provider); }, [data.provider]);

  const save = (patch: NonNullable<InstanceAiUpdate["search"]>) => {
    update.mutate({ search: patch }, {
      onSuccess: () => toast("Ask AI settings saved"),
      onError: (e) => toastErr("Couldn't save Ask AI settings", e as Error),
    });
  };

  const providers = data.providers?.length
    ? data.providers
    : [
        { id: "anthropic", label: "Anthropic" },
        { id: "openai", label: "OpenAI" },
        { id: "codex", label: "ChatGPT" },
      ];
  const suggested = data.suggested_models_by_provider?.[provider] || data.suggested_models || [];
  const selectedModel = modelField.value;

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Ask AI</Text>
          <Text style={styles.meta}>{data.available ? "available" : "off"}</Text>
        </View>
        <Switch value={data.enabled} onValueChange={(enabled) => save({ enabled })} />
      </View>
      {!data.available && data.enabled ? (
        <Text style={styles.hint}>Configure credentials under the Credentials tab.</Text>
      ) : null}
      <Text style={styles.label}>Provider</Text>
      <View style={styles.rowBtns}>
        {providers.map((p) => (
          <Pressable
            key={p.id}
            style={[styles.btn, provider === p.id && styles.btnPrimary]}
            disabled={update.isPending}
            onPress={() => { setProvider(p.id); save({ provider: p.id }); }}
          >
            <Text style={provider === p.id ? styles.btnPrimaryText : styles.btnText}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>Model</Text>
      <View style={styles.rowBtns}>
        {suggested.map((m) => (
          <Pressable
            key={m}
            style={[styles.btn, selectedModel === m && styles.btnPrimary]}
            disabled={update.isPending}
            onPress={() => save({ model: m, model_provider: provider })}
          >
            <Text style={selectedModel === m ? styles.btnPrimaryText : styles.btnText}>{m}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function CredentialsPane({ data }: { data: InstanceAiSettings }) {
  const update = useUpdateInstanceAi();
  const test = useTestInstanceAi();
  const startOauth = useStartCodexOauth();
  const completeOauth = useCompleteCodexOauth();
  const disconnectOauth = useDisconnectCodexOauth();
  const [openaiKey, setOpenaiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [redirectPaste, setRedirectPaste] = useState("");
  const [awaitingPaste, setAwaitingPaste] = useState(false);

  const oauth = data.credentials.oauth;

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>OpenAI API key</Text>
        <Text style={styles.meta}>
          {data.credentials.openai.configured
            ? `${data.credentials.openai.hint} · ${sourceLabel(data.credentials.openai.source)}`
            : sourceLabel(data.credentials.openai.source)}
        </Text>
        <TextInput
          style={styles.input}
          value={openaiKey}
          onChangeText={setOpenaiKey}
          placeholder={data.credentials.openai.configured ? "replace key…" : "sk-…"}
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          secureTextEntry
        />
        <View style={styles.rowBtns}>
          <Pressable
            style={[styles.btn, styles.btnPrimary, !openaiKey.trim() && styles.btnDisabled]}
            disabled={!openaiKey.trim() || update.isPending}
            onPress={() => {
              update.mutate({ credentials: { openai: { api_key: openaiKey.trim() } } }, {
                onSuccess: () => { toast("OpenAI key saved"); setOpenaiKey(""); },
                onError: (e) => toastErr("Couldn't save", e as Error),
              });
            }}
          >
            <Text style={styles.btnPrimaryText}>Save key</Text>
          </Pressable>
          {data.credentials.openai.source === "config" ? (
            <Pressable
              style={[styles.btn, styles.btnDanger]}
              onPress={() => update.mutate({ credentials: { openai: { clear_key: true } } }, {
                onSuccess: () => toast("Cleared"),
                onError: (e) => toastErr("Couldn't clear", e as Error),
              })}
            >
              <Text style={styles.btnDangerText}>Clear saved</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.btn, (!data.credentials.openai.configured || test.isPending) && styles.btnDisabled]}
            disabled={!data.credentials.openai.configured || test.isPending}
            onPress={() => test.mutate("voice", {
              onSuccess: () => toast("OpenAI key works"),
              onError: (e) => toastErr("Test failed", e as Error),
            })}
          >
            <Text style={styles.btnText}>Test</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Anthropic API key</Text>
        <Text style={styles.meta}>
          {data.credentials.anthropic.configured
            ? `${data.credentials.anthropic.hint} · ${sourceLabel(data.credentials.anthropic.source)}`
            : sourceLabel(data.credentials.anthropic.source)}
        </Text>
        <TextInput
          style={styles.input}
          value={anthropicKey}
          onChangeText={setAnthropicKey}
          placeholder={data.credentials.anthropic.configured ? "replace key…" : "sk-ant-…"}
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          secureTextEntry
        />
        <View style={styles.rowBtns}>
          <Pressable
            style={[styles.btn, styles.btnPrimary, !anthropicKey.trim() && styles.btnDisabled]}
            disabled={!anthropicKey.trim() || update.isPending}
            onPress={() => {
              update.mutate({ credentials: { anthropic: { api_key: anthropicKey.trim() } } }, {
                onSuccess: () => { toast("Anthropic key saved"); setAnthropicKey(""); },
                onError: (e) => toastErr("Couldn't save", e as Error),
              });
            }}
          >
            <Text style={styles.btnPrimaryText}>Save key</Text>
          </Pressable>
          {data.credentials.anthropic.source === "config" ? (
            <Pressable
              style={[styles.btn, styles.btnDanger]}
              onPress={() => update.mutate({ credentials: { anthropic: { clear_key: true } } }, {
                onSuccess: () => toast("Cleared"),
                onError: (e) => toastErr("Couldn't clear", e as Error),
              })}
            >
              <Text style={styles.btnDangerText}>Clear saved</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>ChatGPT sign-in</Text>
        <Text style={styles.meta}>
          {oauth.configured
            ? `Linked · ${oauth.hint || "token"}${oauth.account_id ? ` · ${oauth.account_id}` : ""}`
            : "Not linked — authorize from this device (paste redirect URL)."}
        </Text>
        <View style={styles.rowBtns}>
          <Pressable
            style={[styles.btn, styles.btnPrimary]}
            disabled={startOauth.isPending}
            onPress={() => {
              startOauth.mutate("paste", {
                onSuccess: async (res) => {
                  setAwaitingPaste(true);
                  await Linking.openURL(res.authorize_url);
                  toast("Finish sign-in, then paste the redirected URL");
                },
                onError: (e) => toastErr("Couldn't start", e as Error),
              });
            }}
          >
            <Text style={styles.btnPrimaryText}>
              {oauth.configured ? "Re-authorize" : "Authorize ChatGPT"}
            </Text>
          </Pressable>
          {oauth.configured ? (
            <Pressable
              style={[styles.btn, styles.btnDanger]}
              disabled={disconnectOauth.isPending}
              onPress={() => disconnectOauth.mutate(undefined, {
                onSuccess: () => toast("Disconnected"),
                onError: (e) => toastErr("Couldn't disconnect", e as Error),
              })}
            >
              <Text style={styles.btnDangerText}>Disconnect</Text>
            </Pressable>
          ) : null}
        </View>
        {awaitingPaste ? (
          <>
            <Text style={styles.label}>Redirect URL</Text>
            <TextInput
              style={styles.input}
              value={redirectPaste}
              onChangeText={setRedirectPaste}
              placeholder="http://localhost:1455/auth/callback?code=…"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
            />
            <Pressable
              style={[styles.btn, styles.btnPrimary, !redirectPaste.trim() && styles.btnDisabled]}
              disabled={!redirectPaste.trim() || completeOauth.isPending}
              onPress={() => completeOauth.mutate(redirectPaste.trim(), {
                onSuccess: () => {
                  toast("ChatGPT linked");
                  setAwaitingPaste(false);
                  setRedirectPaste("");
                },
                onError: (e) => toastErr("Couldn't complete", e as Error),
              })}
            >
              <Text style={styles.btnPrimaryText}>Complete</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </>
  );
}

export default function InstanceAiScreen() {
  const me = useMe();
  const isAdmin = me.data?.instance_admin === true;
  const q = useInstanceAi(isAdmin);
  const [tab, setTab] = useState<"features" | "credentials">("features");

  if (me.isSuccess && !isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: "Settings", headerShown: true }} />
        <View style={[styles.root, styles.content]}>
          <Text style={styles.hint}>Instance admin access required.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Settings", headerShown: true }} />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.rowBtns}>
          <Pressable
            style={[styles.btn, tab === "features" && styles.btnPrimary]}
            onPress={() => setTab("features")}
          >
            <Text style={tab === "features" ? styles.btnPrimaryText : styles.btnText}>Features</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, tab === "credentials" && styles.btnPrimary]}
            onPress={() => setTab("credentials")}
          >
            <Text style={tab === "credentials" ? styles.btnPrimaryText : styles.btnText}>Credentials</Text>
          </Pressable>
        </View>
        {q.isLoading ? <ActivityIndicator color={colors.dim} /> : null}
        {q.isError ? <Text style={styles.hint}>Couldn&apos;t load AI settings.</Text> : null}
        {q.data && tab === "features" ? (
          <>
            <Text style={styles.hint}>
              Choose providers and models. Keys and ChatGPT sign-in live under Credentials.
            </Text>
            <VoiceFeatures data={q.data.voice} />
            <SearchFeatures data={q.data.search} />
          </>
        ) : null}
        {q.data && tab === "credentials" ? (
          <>
            <Text style={styles.hint}>
              Env keys show masked. Saving overrides env for this instance; clear restores env.
            </Text>
            <CredentialsPane data={q.data} />
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
