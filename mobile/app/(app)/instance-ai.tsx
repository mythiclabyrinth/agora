/* Instance-admin AI & voice settings (parity with the web AI & voice panel). */

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
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

type SelectOption = { id: string; label: string };

function SelectField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);

  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        style={[styles.select, disabled && styles.btnDisabled]}
        disabled={disabled || options.length === 0}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens a list of options"
        onPress={() => setOpen(true)}
      >
        <Text style={styles.selectValue} numberOfLines={1}>
          {selected?.label ?? (value || "Select…")}
        </Text>
        <Text style={styles.selectChevron}>▾</Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.selectModal}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={styles.selectSheet} accessibilityRole="menu">
            <Text style={styles.selectSheetTitle}>{label}</Text>
            <ScrollView style={styles.selectList} keyboardShouldPersistTaps="handled">
              {options.map((o) => {
                const active = o.id === value;
                return (
                  <Pressable
                    key={o.id}
                    style={[styles.selectOption, active && styles.selectOptionActive]}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      onChange(o.id);
                      setOpen(false);
                    }}
                  >
                    <Text
                      style={active ? styles.selectOptionTextActive : styles.selectOptionText}
                      numberOfLines={1}
                    >
                      {o.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SttFeatures({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();
  const [sttProvider, setSttProvider] = useState(data.stt_provider);

  useEffect(() => {
    setSttProvider(data.stt_provider);
  }, [data.stt_provider]);

  const save = (patch: NonNullable<InstanceAiUpdate["voice"]>) => {
    update.mutate({ voice: patch }, {
      onSuccess: () => toast("Speech-to-text settings saved"),
      onError: (e) => toastErr("Couldn't save speech-to-text settings", e as Error),
    });
  };

  const sttProviders = data.stt_providers?.length
    ? data.stt_providers
    : [
        { id: "openai", label: "OpenAI" },
        { id: "groq", label: "Groq" },
      ];
  const stt = (data.stt_models?.[sttProvider as "openai" | "groq"] || data.stt_model).value;
  const suggested = data.suggested_stt_models_by_provider?.[sttProvider]
    || data.suggested_stt_models
    || [];

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Voice — speech to text</Text>
        </View>
        <Switch
          value={data.stt_enabled}
          onValueChange={(stt_enabled) => save({ stt_enabled })}
        />
      </View>
      <Text style={styles.hint}>Voice notes: the composer microphone.</Text>
      <SelectField
        label="Provider"
        value={sttProvider}
        options={sttProviders}
        disabled={update.isPending}
        onChange={(id) => { setSttProvider(id); save({ stt_provider: id }); }}
      />
      <SelectField
        label="Model"
        value={stt}
        options={[
          ...suggested.map((m) => ({ id: m, label: m })),
          ...(stt && !suggested.includes(stt) ? [{ id: stt, label: stt }] : []),
        ]}
        disabled={update.isPending}
        onChange={(id) => save({ stt_model: id, stt_model_provider: sttProvider })}
      />
    </View>
  );
}

function TtsFeatures({ data }: { data: InstanceAiSettings["voice"] }) {
  const update = useUpdateInstanceAi();
  const [ttsProvider, setTtsProvider] = useState(data.tts_provider);

  useEffect(() => {
    setTtsProvider(data.tts_provider);
  }, [data.tts_provider]);

  const save = (patch: NonNullable<InstanceAiUpdate["voice"]>) => {
    update.mutate({ voice: patch }, {
      onSuccess: () => toast("Text-to-speech settings saved"),
      onError: (e) => toastErr("Couldn't save text-to-speech settings", e as Error),
    });
  };

  const ttsProviders = data.tts_providers?.length
    ? data.tts_providers
    : [
        { id: "openai", label: "OpenAI" },
        { id: "groq", label: "Groq" },
      ];
  const tts = (data.tts_models?.[ttsProvider as "openai" | "groq"] || data.tts_model).value;
  const voice = (data.tts_voices?.[ttsProvider as "openai" | "groq"] || data.tts_voice).value;
  const accent = data.tts_accent?.value || "american";
  const suggested = data.suggested_tts_models_by_provider?.[ttsProvider]
    || data.suggested_tts_models
    || [];
  const voices = data.suggested_tts_voices_by_provider?.[ttsProvider]
    || data.suggested_tts_voices
    || [];
  const accents = data.tts_accents?.length
    ? data.tts_accents
    : [
        { id: "american", label: "American English" },
        { id: "british", label: "British English" },
        { id: "arabic", label: "Arabic (Saudi)" },
      ];
  const voiceOptions = [
    ...(data.suggested_tts_voice_options_by_provider?.[ttsProvider]
      || data.suggested_tts_voice_options
      || voices.map((id) => ({ id, label: id }))),
  ];
  if (voice && !voiceOptions.some((o) => o.id === voice)) {
    voiceOptions.push({ id: voice, label: voice });
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Voice — text to speech</Text>
        </View>
        <Switch
          value={data.tts_enabled}
          onValueChange={(tts_enabled) => save({ tts_enabled })}
        />
      </View>
      <Text style={styles.hint}>Speak-aloud, and live voice together with speech to text.</Text>
      <SelectField
        label="Provider"
        value={ttsProvider}
        options={ttsProviders}
        disabled={update.isPending}
        onChange={(id) => { setTtsProvider(id); save({ tts_provider: id }); }}
      />
      <SelectField
        label="Accent"
        value={accent}
        options={accents}
        disabled={update.isPending}
        onChange={(id) => save({ tts_accent: id, tts_model_provider: ttsProvider })}
      />
      <SelectField
        label="Voice"
        value={voice}
        options={voiceOptions}
        disabled={update.isPending}
        onChange={(id) => save({ tts_voice: id, tts_model_provider: ttsProvider })}
      />
      <SelectField
        label="Model"
        value={tts}
        options={[
          ...suggested.map((m) => ({ id: m, label: m })),
          ...(tts && !suggested.includes(tts) ? [{ id: tts, label: tts }] : []),
        ]}
        disabled={update.isPending}
        onChange={(id) => save({ tts_model: id, tts_model_provider: ttsProvider })}
      />
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
        { id: "codex", label: "Codex OAuth" },
      ];
  const suggested = data.suggested_models_by_provider?.[provider] || data.suggested_models || [];
  const selectedModel = modelField.value;

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Ask AI</Text>
        </View>
        <Switch value={data.enabled} onValueChange={(enabled) => save({ enabled })} />
      </View>
      <SelectField
        label="Provider"
        value={provider}
        options={providers}
        disabled={update.isPending}
        onChange={(id) => { setProvider(id); save({ provider: id }); }}
      />
      <SelectField
        label="Model"
        value={selectedModel}
        options={[
          ...suggested.map((m) => ({ id: m, label: m })),
          ...(selectedModel && !suggested.includes(selectedModel)
            ? [{ id: selectedModel, label: selectedModel }]
            : []),
        ]}
        disabled={update.isPending}
        onChange={(id) => save({ model: id, model_provider: provider })}
      />
    </View>
  );
}

function KeyCard({
  envName, configured, canClear, value, onChange, placeholder, onSave, onTest, onClear, testing, saving,
}: {
  envName: string;
  configured: boolean;
  canClear: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSave: () => void;
  onTest: () => void;
  onClear: () => void;
  testing: boolean;
  saving: boolean;
}) {
  return (
    <View style={styles.keyCard}>
      <Text style={styles.envName}>{envName}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={configured ? "Replace key…" : placeholder}
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        secureTextEntry
      />
      <View style={styles.rowBtns}>
        <Pressable
          style={[styles.btn, styles.btnPrimary, !value.trim() && styles.btnDisabled]}
          disabled={!value.trim() || saving}
          onPress={onSave}
        >
          <Text style={styles.btnPrimaryText}>Save</Text>
        </Pressable>
        {configured ? (
          <Pressable
            style={[styles.btn, testing && styles.btnDisabled]}
            disabled={testing}
            onPress={onTest}
          >
            <Text style={styles.btnText}>{testing ? "Testing…" : "Test"}</Text>
          </Pressable>
        ) : null}
        {canClear ? (
          <Pressable style={[styles.btn, styles.btnDanger]} onPress={onClear}>
            <Text style={styles.btnDangerText}>Clear</Text>
          </Pressable>
        ) : null}
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
  const [groqKey, setGroqKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [redirectPaste, setRedirectPaste] = useState("");
  const [awaitingPaste, setAwaitingPaste] = useState(false);

  const oauth = data.credentials.oauth;

  return (
    <>
      <View style={styles.keysSection}>
        <View style={styles.keysHead}>
          <Text style={styles.oauthHead}>API keys</Text>
          <Text style={styles.hint}>Provider keys used for model calls. Values are write-only.</Text>
        </View>
        <KeyCard
          envName="OPENAI API KEY"
          configured={data.credentials.openai.configured}
          canClear={data.credentials.openai.source === "config"}
          value={openaiKey}
          onChange={setOpenaiKey}
          placeholder="Paste key…"
          saving={update.isPending}
          testing={test.isPending}
          onSave={() => {
            update.mutate({ credentials: { openai: { api_key: openaiKey.trim() } } }, {
              onSuccess: () => { toast("OpenAI key saved"); setOpenaiKey(""); },
              onError: (e) => toastErr("Couldn't save", e as Error),
            });
          }}
          onTest={() => test.mutate("openai", {
            onSuccess: () => toast("OpenAI credentials work"),
            onError: (e) => toastErr("OpenAI test failed", e as Error),
          })}
          onClear={() => update.mutate({ credentials: { openai: { clear_key: true } } }, {
            onSuccess: () => toast("Cleared"),
            onError: (e) => toastErr("Couldn't clear", e as Error),
          })}
        />
        <KeyCard
          envName="GROQ API KEY"
          configured={data.credentials.groq.configured}
          canClear={data.credentials.groq.source === "config"}
          value={groqKey}
          onChange={setGroqKey}
          placeholder="Paste key…"
          saving={update.isPending}
          testing={test.isPending}
          onSave={() => {
            update.mutate({ credentials: { groq: { api_key: groqKey.trim() } } }, {
              onSuccess: () => { toast("Groq key saved"); setGroqKey(""); },
              onError: (e) => toastErr("Couldn't save", e as Error),
            });
          }}
          onTest={() => test.mutate("groq", {
            onSuccess: () => toast("Groq credentials work"),
            onError: (e) => toastErr("Groq test failed", e as Error),
          })}
          onClear={() => update.mutate({ credentials: { groq: { clear_key: true } } }, {
            onSuccess: () => toast("Cleared"),
            onError: (e) => toastErr("Couldn't clear", e as Error),
          })}
        />
        <KeyCard
          envName="ANTHROPIC API KEY"
          configured={data.credentials.anthropic.configured}
          canClear={data.credentials.anthropic.source === "config"}
          value={anthropicKey}
          onChange={setAnthropicKey}
          placeholder="Paste key…"
          saving={update.isPending}
          testing={test.isPending}
          onSave={() => {
            update.mutate({ credentials: { anthropic: { api_key: anthropicKey.trim() } } }, {
              onSuccess: () => { toast("Anthropic key saved"); setAnthropicKey(""); },
              onError: (e) => toastErr("Couldn't save", e as Error),
            });
          }}
          onTest={() => test.mutate("anthropic", {
            onSuccess: () => toast("Anthropic credentials work"),
            onError: (e) => toastErr("Anthropic test failed", e as Error),
          })}
          onClear={() => update.mutate({ credentials: { anthropic: { clear_key: true } } }, {
            onSuccess: () => toast("Cleared"),
            onError: (e) => toastErr("Couldn't clear", e as Error),
          })}
        />
      </View>

      <View style={styles.oauthSection}>
        <Text style={styles.oauthHead}>OAuth</Text>
        <View style={styles.oauthCard}>
          <Text style={styles.cardTitle}>OpenAI Codex</Text>
          <Text style={styles.hint}>Sign in to your ChatGPT subscription.</Text>
          <View style={styles.oauthStatus}>
            <Text style={[styles.oauthBadge, oauth.configured && styles.oauthBadgeOn]}>
              {oauth.configured ? "connected" : "not connected"}
            </Text>
            {oauth.configured && oauth.account_id ? (
              <Text style={styles.meta}>{oauth.account_id}</Text>
            ) : null}
            {oauth.configured ? (
              <Text style={styles.meta}>tokens refresh automatically</Text>
            ) : null}
          </View>
          <View style={styles.rowBtns}>
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
            {oauth.configured ? (
              <Pressable
                style={[styles.btn, test.isPending && styles.btnDisabled]}
                disabled={test.isPending}
                onPress={() => test.mutate("codex", {
                  onSuccess: () => toast("Codex OAuth credentials work"),
                  onError: (e) => toastErr("Codex OAuth test failed", e as Error),
                })}
              >
                <Text style={styles.btnText}>{test.isPending ? "Testing…" : "Test"}</Text>
              </Pressable>
            ) : null}
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
                {oauth.configured ? "Re-authenticate" : "Connect account"}
              </Text>
            </Pressable>
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
                    toast("Codex OAuth linked");
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
              Choose providers and models. Keys and Codex OAuth live under Credentials.
            </Text>
            <SttFeatures data={q.data.voice} />
            <TtsFeatures data={q.data.voice} />
            <SearchFeatures data={q.data.search} />
          </>
        ) : null}
        {q.data && tab === "credentials" ? (
          <CredentialsPane data={q.data} />
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
  select: {
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  selectValue: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "600" },
  selectChevron: { color: colors.dim, fontSize: 12 },
  selectModal: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 24,
  },
  selectSheet: {
    backgroundColor: colors.sheet,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 14,
    padding: 10,
    maxHeight: "70%",
  },
  selectSheetTitle: {
    color: colors.dim,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  selectList: { maxHeight: 360 },
  selectOption: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12 },
  selectOptionActive: { backgroundColor: colors.panelStrong },
  selectOptionText: { color: colors.text, fontSize: 15, fontWeight: "500" },
  selectOptionTextActive: { color: colors.text, fontSize: 15, fontWeight: "700" },
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
  keysSection: { gap: 10 },
  keysHead: { gap: 4, marginBottom: 2 },
  keyCard: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  envName: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  oauthSection: { marginTop: 8, gap: 10 },
  oauthHead: {
    color: colors.text,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    borderLeftWidth: 3,
    borderLeftColor: colors.a1,
    paddingLeft: 10,
  },
  oauthCard: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  oauthStatus: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  oauthBadge: {
    color: colors.dim,
    backgroundColor: colors.panelStrong,
    overflow: "hidden",
    borderRadius: 7,
    paddingHorizontal: 9,
    paddingVertical: 3,
    fontSize: 11,
    fontWeight: "700",
  },
  oauthBadgeOn: {
    color: "#6ecbf5",
    backgroundColor: "rgba(54,197,240,0.13)",
  },
});
