/* Native connection catalog and credential manager. The route owns only the
   app chrome; keeping this flow here makes every state available to Storybook. */

import React, { useMemo, useState } from "react";
import {
  Image,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { openLinkOrThrow } from "../lib/openLink";
import { recordPositiveEvent } from "../lib/storeReview";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Lock,
  Share2,
} from "lucide-react-native";
import {
  agentWsUrl,
  fmtTs,
  inferPairingKind,
  originOf,
  type PairingKind,
  type PairingToken,
  type AgentSource,
  useAgentDmPolicy,
  useAgentSources,
  useUpdateAgentDmPolicy,
  useUsers,
  useConnectionMutations,
  useConnections,
  usePairingMutations,
  usePairingTokens,
} from "@agora/core";
import { ArmedButton } from "./ArmedButton";
import { AgentAvatar } from "./AgentAvatar";
import { AgentStatus } from "./AgentStatus";
import { toast, toastErr } from "./Toast";
import { colors, mono } from "../lib/theme";
import { useSession } from "../state/session";

type AddKind = "pantheo" | "coding" | "generic" | PairingKind;
type ConnectableKind = Exclude<AddKind, "coding" | "generic">;

type Definition = {
  kind: ConnectableKind;
  title: string;
  shortTitle: string;
  description: string;
  defaultLabel: string;
  local?: boolean;
  guide?: string;
  image: number;
};

const definitions: Definition[] = [
  {
    kind: "codex",
    title: "Codex CLI",
    shortTitle: "Codex",
    description: "Continue Codex sessions and work on repositories from Agora.",
    defaultLabel: "Codex",
    local: true,
    image: require("../../assets/agents/codex.png"),
  },
  {
    kind: "cursor",
    title: "Cursor CLI",
    shortTitle: "Cursor",
    description: "Run Cursor CLI against projects on your computer.",
    defaultLabel: "Cursor",
    local: true,
    image: require("../../assets/agents/cursor.png"),
  },
  {
    kind: "claude",
    title: "Claude Code",
    shortTitle: "Claude",
    description: "Continue Claude Code sessions from any Agora channel.",
    defaultLabel: "Claude",
    local: true,
    image: require("../../assets/agents/claude.png"),
  },
  {
    kind: "hermes",
    title: "Hermes",
    shortTitle: "Hermes",
    description: "Give Hermes secure access to join rooms in this Agora.",
    defaultLabel: "Hermes",
    guide: "/docs/agents/hermes.html",
    image: require("../../assets/agents/hermes.png"),
  },
  {
    kind: "claw",
    title: "OpenClaw",
    shortTitle: "OpenClaw",
    description: "Create secure access for an OpenClaw agent.",
    defaultLabel: "OpenClaw",
    guide: "/docs/agents/openclaw.html",
    image: require("../../assets/agents/openclaw.png"),
  },
  {
    kind: "pantheo",
    title: "Pantheo instance",
    shortTitle: "Pantheo",
    description:
      "Link another server and make all of its Agora-enabled agents available.",
    defaultLabel: "",
    image: require("../../assets/agents/pantheo.png"),
  },
];

const byKind = Object.fromEntries(
  definitions.map((d) => [d.kind, d]),
) as Record<ConnectableKind, Definition>;

function AgentMark({
  definition,
  size = 48,
}: {
  definition?: Definition;
  size?: number;
}) {
  return definition ? (
    <Image
      source={definition.image}
      style={{ width: size, height: size, borderRadius: size * 0.24 }}
    />
  ) : (
    <View
      style={[
        styles.fallbackMark,
        { width: size, height: size, borderRadius: size * 0.24 },
      ]}
    >
      <Bot size={size * 0.52} color={colors.a2} />
    </View>
  );
}

function Back({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
      style={styles.back}
      onPress={onPress}
    >
      <ChevronLeft size={17} color={colors.a1} />
      <Text style={styles.backText}>{label}</Text>
    </Pressable>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primary,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function Card({
  definition,
  wide,
  onPress,
}: {
  definition: Definition;
  wide: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Connect ${definition.title}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        wide && styles.cardWide,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.cardTop}>
        <AgentMark definition={definition} />
        {definition.local ? (
          <Text style={styles.localBadge}>Runs on your computer</Text>
        ) : null}
      </View>
      <View style={styles.cardTitleRow}>
        <Text style={styles.cardTitle}>{definition.title}</Text>
        <ChevronRight size={18} color={colors.dim} />
      </View>
      <Text style={styles.cardDescription}>{definition.description}</Text>
    </Pressable>
  );
}

function Credential({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(value);
      toast(`${label} copied`);
    } catch (error) {
      toastErr(`Couldn't copy ${label.toLowerCase()}`, error);
    }
  };
  const share = async () => {
    try {
      await Share.share({ message: value });
    } catch (error) {
      toastErr(`Couldn't share ${label.toLowerCase()}`, error);
    }
  };
  return (
    <View style={styles.credential}>
      <Text selectable style={styles.credentialText}>
        {value}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy ${label}`}
        style={styles.iconButton}
        onPress={() => void copy()}
      >
        <Copy size={19} color={colors.a1} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Share ${label}`}
        style={styles.iconButton}
        onPress={() => void share()}
      >
        <Share2 size={19} color={colors.a1} />
      </Pressable>
    </View>
  );
}

export function AddAgentFlow({
  onDone,
  initialKind = null,
  initialIssued = null,
}: {
  onDone?: () => void;
  /** Deterministic entry points for component catalogs and focused tests. */
  initialKind?: AddKind | null;
  initialIssued?: string | null;
}) {
  const session = useSession((s) => s.session);
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const connectionMutations = useConnectionMutations();
  const pairingMutations = usePairingMutations();
  const [kind, setKind] = useState<AddKind | null>(initialKind);
  const [agentName, setAgentName] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [url, setUrl] = useState("");
  const [connectionToken, setConnectionToken] = useState("");
  const [issued, setIssued] = useState<string | null>(initialIssued);

  if (!session) return null;

  const select = (next: AddKind) => {
    setKind(next);
    setIssued(null);
    setConnectionName("");
    setUrl("");
    setConnectionToken("");
    setAgentName(
      next !== "pantheo" && next !== "coding" && next !== "generic"
        ? byKind[next].defaultLabel
        : "",
    );
  };

  if (kind === null) {
    return (
      <View style={styles.flow}>
        <View style={styles.intro}>
          <Text maxFontSizeMultiplier={1.15} style={styles.kicker}>
            Bring your agents into the conversation
          </Text>
          <Text maxFontSizeMultiplier={1.2} style={styles.hero}>
            What would you like to connect?
          </Text>
          <Text style={styles.heroCopy}>
            Link an agent service or choose a coding agent that runs on your
            computer.
          </Text>
        </View>
        <View style={styles.grid}>
          <Card
            definition={byKind.pantheo}
            wide={wide}
            onPress={() => select("pantheo")}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Connect a coding agent"
            onPress={() => select("coding")}
            style={({ pressed }) => [
              styles.card,
              wide && styles.cardWide,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.logoStack}>
              {[byKind.codex, byKind.cursor, byKind.claude].map((d) => (
                <AgentMark key={d.kind} definition={d} size={42} />
              ))}
            </View>
            <Text style={styles.localBadge}>Runs on your computer</Text>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>Coding agents</Text>
              <ChevronRight size={18} color={colors.dim} />
            </View>
            <Text style={styles.cardDescription}>
              Connect Codex CLI, Cursor CLI, or Claude Code.
            </Text>
          </Pressable>
          <Card
            definition={byKind.hermes}
            wide={wide}
            onPress={() => select("hermes")}
          />
          <Card
            definition={byKind.claw}
            wide={wide}
            onPress={() => select("claw")}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create access for another agent"
            onPress={() => select("generic")}
            style={({ pressed }) => [
              styles.card,
              wide && styles.cardWide,
              pressed && styles.pressed,
            ]}
          >
            <AgentMark />
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>Another agent</Text>
              <ChevronRight size={18} color={colors.dim} />
            </View>
            <Text style={styles.cardDescription}>
              Issue generic access for a custom or future integration.
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (kind === "coding") {
    return (
      <View style={styles.flow}>
        <Back label="All connection types" onPress={() => setKind(null)} />
        <View style={styles.intro}>
          <Text maxFontSizeMultiplier={1.15} style={styles.kicker}>
            Runs on your computer
          </Text>
          <Text maxFontSizeMultiplier={1.2} style={styles.hero}>
            Choose a coding agent
          </Text>
          <Text style={styles.heroCopy}>
            Continue local coding sessions and repository work from Agora.
          </Text>
        </View>
        <View style={styles.grid}>
          {(["codex", "cursor", "claude"] as const).map((k) => (
            <Card
              key={k}
              definition={byKind[k]}
              wide={wide}
              onPress={() => select(k)}
            />
          ))}
        </View>
      </View>
    );
  }

  if (kind === "pantheo") {
    return (
      <View style={styles.flow}>
        <Back label="All connection types" onPress={() => setKind(null)} />
        <View style={styles.setupHead}>
          <AgentMark definition={byKind.pantheo} />
          <View style={styles.setupTitle}>
            <Text maxFontSizeMultiplier={1.15} style={styles.kicker}>
              Linked agent server
            </Text>
            <Text maxFontSizeMultiplier={1.2} style={styles.heroSmall}>
              Link a Pantheo instance
            </Text>
          </View>
        </View>
        <View style={styles.form}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={connectionName}
            onChangeText={setConnectionName}
            placeholder="e.g. Home"
            placeholderTextColor={colors.faint}
          />
          <Text style={styles.label}>Server address</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            keyboardType="url"
            placeholder="wss://pantheo.example/agora/connect"
            placeholderTextColor={colors.faint}
          />
          <Text style={styles.label}>API token</Text>
          <TextInput
            style={styles.input}
            value={connectionToken}
            onChangeText={setConnectionToken}
            autoCapitalize="none"
            secureTextEntry
            placeholder="PANTHEO_API_TOKEN"
            placeholderTextColor={colors.faint}
          />
          <PrimaryButton
            label={
              connectionMutations.add.isPending ? "Linking…" : "Link instance"
            }
            disabled={connectionMutations.add.isPending}
            onPress={() => {
              if (!connectionName.trim() || !url.trim()) {
                toast("Name and address required");
                return;
              }
              connectionMutations.add.mutate(
                {
                  name: connectionName.trim(),
                  url: url.trim(),
                  token: connectionToken.trim(),
                },
                {
                  onSuccess: () => {
                    setConnectionName("");
                    setUrl("");
                    setConnectionToken("");
                    toast("Linked — connecting…");
                    void recordPositiveEvent();
                    onDone?.();
                  },
                  onError: (e) => toastErr("Link failed", e),
                },
              );
            }}
          />
        </View>
        <Text style={styles.note}>
          Use Pantheo’s public wss:// address when it runs on another machine.
        </Text>
      </View>
    );
  }

  const definition = kind === "generic" ? undefined : byKind[kind];
  const local = !!definition?.local;
  const serverOrigin = originOf(session.baseUrl, session.baseUrl).replace(
    /\/+$/,
    "",
  );
  const guideUrl = definition?.guide
    ? `${serverOrigin}${definition.guide}`
    : local ? `${serverOrigin}/docs/coding-agents/${kind}.html` : null;
  if (issued) {
    const socket = agentWsUrl(serverOrigin, issued);
    return (
      <View style={styles.success}>
        <View style={styles.successMark}>
          <Check size={28} color={colors.onAccent} />
        </View>
        <Text maxFontSizeMultiplier={1.2} style={styles.heroSmall}>
          {definition?.title ?? "Agent"} access created
        </Text>
        <Text style={styles.heroCopy}>
          {guideUrl
            ? "Carry this access credential to your computer, then follow the setup guide to configure and start the agent."
            : "Use this credential in the agent’s Agora settings."}
        </Text>
        <Text style={styles.label}>Access token</Text>
        <Credential label="Token" value={issued} />
        {!local ? (
          <>
            <Text style={styles.label}>Connection address</Text>
            <Credential label="Connection address" value={socket} />
          </>
        ) : null}
        {guideUrl ? (
          <PrimaryButton
            label="Open setup guide"
            onPress={() =>
              void openLinkOrThrow(guideUrl).catch((error) =>
                toastErr("Couldn't open setup guide", error),
              )
            }
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View connections"
          style={styles.secondary}
          onPress={onDone}
        >
          <Text style={styles.secondaryText}>View connections</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.flow}>
      <Back
        label={local ? "Coding agents" : "All connection types"}
        onPress={() => setKind(local ? "coding" : null)}
      />
      <View style={styles.setupHead}>
        <AgentMark definition={definition} />
        <View style={styles.setupTitle}>
          <Text maxFontSizeMultiplier={1.15} style={styles.kicker}>
            {local ? "Coding agent" : "Secure agent access"}
          </Text>
          <Text maxFontSizeMultiplier={1.2} style={styles.heroSmall}>
            Create access for {definition?.title ?? "another agent"}
          </Text>
        </View>
      </View>
      {guideUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open full setup guide"
          style={styles.guideLink}
          onPress={() =>
            void openLinkOrThrow(guideUrl).catch((error) =>
              toastErr("Couldn't open setup guide", error),
            )
          }
        >
          <Text style={styles.backText}>Open full setup guide</Text>
          <ExternalLink size={15} color={colors.a1} />
        </Pressable>
      ) : null}
      <Text style={styles.heroCopy}>
        Choose a friendly name so you can recognize this agent later.
      </Text>
      <View style={styles.form}>
        <Text style={styles.label}>Agent name</Text>
        <TextInput
          style={styles.input}
          value={agentName}
          onChangeText={setAgentName}
          autoFocus
          placeholder={definition?.defaultLabel ?? "Agent"}
          placeholderTextColor={colors.faint}
          returnKeyType="done"
        />
        <PrimaryButton
          label={
            pairingMutations.create.isPending ? "Creating…" : "Create access"
          }
          disabled={pairingMutations.create.isPending}
          onPress={() => {
            const name =
              agentName.trim() || definition?.defaultLabel || "agent";
            pairingMutations.create.mutate(
              { name, kind: kind === "generic" ? undefined : kind },
              {
                onSuccess: (result) => {
                  setIssued(result.token);
                  setAgentName("");
                },
                onError: (e) => toastErr("Couldn't create access", e),
              },
            );
          }}
        />
      </View>
      {local ? (
        <View style={styles.security}>
          <Lock size={17} color={colors.a2} />
          <Text style={styles.securityText}>
            This CLI runs on your computer and can access only what its local
            configuration allows.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function NativeAgentAccess({ agent, onBack }: { agent: AgentSource["agents"][number]; onBack: () => void }) {
  const policy=useAgentDmPolicy(agent.id);
  const users=useUsers();
  const update=useUpdateAgentDmPolicy(agent.id);
  const [filter,setFilter]=useState("");
  const save=(is_public:boolean,grants:string[])=>update.mutate({is_public,grants},{onError:error=>toastErr("DM access update failed",error)});
  return <View style={styles.flow}>
    <Pressable style={styles.backRow} onPress={onBack}><ChevronLeft size={18} color={colors.a1}/><Text style={styles.accessBackText}>Back</Text></Pressable>
    <View style={styles.accessHeader}><AgentAvatar agentId={agent.id} size={38}/><View style={styles.rowMain}><Text numberOfLines={1} style={styles.accessHeading}>{agent.name}</Text><AgentStatus live={agent.live}/>{!agent.live?<Text style={styles.accessStatus}>Messages remain available in history</Text>:null}</View></View>
    {!policy.data?<Text style={styles.empty}>Loading access…</Text>:<>
      <View style={styles.accessSwitch}><View style={styles.rowMain}><Text style={styles.rowName}>Public</Text><Text style={styles.rowMeta}>Everyone on this Agora can start a direct message</Text></View><Switch value={policy.data.is_public} disabled={update.isPending} onValueChange={value=>save(value,policy.data!.grants)}/></View>
      <View style={styles.accessSectionHead}><Text style={styles.sectionTitle}>People with access</Text><Text style={styles.accessHint}>Instance admins always have access. Select additional members below.</Text></View>
      {!policy.data.is_public?<><TextInput accessibilityLabel="Search people" placeholder="Search people" placeholderTextColor={colors.faint} style={styles.input} value={filter} onChangeText={setFilter}/>{(users.data??[]).filter(user=>!user.disabled&&user.instance_role!=="admin"&&`${user.display_name} ${user.username}`.toLowerCase().includes(filter.toLowerCase())).map(user=>{
        const checked=policy.data!.grants.includes(user.username);
        return <Pressable key={user.username} disabled={update.isPending} style={styles.accessUser} onPress={()=>save(false,checked?policy.data!.grants.filter(x=>x!==user.username):[...policy.data!.grants,user.username])}>
          <View style={styles.rowMain}><Text style={styles.rowName}>{user.display_name||user.username}</Text><Text style={styles.rowMeta}>@{user.username}</Text></View><Text style={styles.checkText}>{checked?"✓":"○"}</Text>
        </Pressable>;
      })}</>:null}
    </>}
  </View>;
}

export function AgentConnectionsList() {
  const admin = useSession((s) => s.instanceAdmin);
  const connections = useConnections(true, admin);
  // Deliberate order: enabled first, polling second.
  const pairing = usePairingTokens(admin, true);
  const connectionMutations = useConnectionMutations();
  const pairingMutations = usePairingMutations();
  const sources = useAgentSources(admin, true);
  const [accessSource, setAccessSource] = useState<AgentSource | null>(null);
  const [accessAgent, setAccessAgent] = useState<AgentSource["agents"][number] | null>(null);
  const definitionFor = (token: PairingToken) => {
    const kind = inferPairingKind(token);
    return kind ? byKind[kind] : undefined;
  };
  const manageSource = (kind: AgentSource["kind"], id: string) => {
    const source=(sources.data??[]).find(item=>item.kind===kind&&item.id===id);
    if (!source) { toast("Agent roster is still loading"); return; }
    setAccessSource(source);
    if (kind === "pairing" && source.agents.length === 1) setAccessAgent(source.agents[0]);
  };
  if (accessAgent) return <NativeAgentAccess agent={accessAgent} onBack={() => {
    setAccessAgent(null);
    if (accessSource?.kind === "pairing" && accessSource.agents.length === 1) setAccessSource(null);
  }} />;
  if (accessSource) return <View style={styles.flow}>
    <Pressable style={styles.backRow} onPress={()=>setAccessSource(null)}><ChevronLeft size={18} color={colors.a1}/><Text style={styles.accessBackText}>Connections</Text></Pressable>
    <Text style={styles.sectionTitle}>{accessSource.name}</Text>
    <Text style={styles.empty}>Choose an agent to manage who can start a direct message.</Text>
    {accessSource.agents.map(agent=><Pressable key={agent.id} style={styles.accessAgentRow} onPress={()=>setAccessAgent(agent)}>
      <AgentAvatar agentId={agent.id} size={34}/><View style={styles.rowMain}><Text numberOfLines={1} style={styles.rowName}>{agent.name}</Text><AgentStatus live={agent.live}/></View><ChevronRight size={18} color={colors.dim}/>
    </Pressable>)}
    {!accessSource.agents.length?<Text style={styles.empty}>No agents have registered through this connection yet.</Text>:null}
  </View>;
  return (
    <View style={styles.flow}>
      <Text style={styles.sectionTitle}>Pantheo instances</Text>
      {(connections.data ?? []).map((connection) => (
        <View key={connection.name} style={styles.row}>
          <View style={styles.rowTop}>
            <View style={styles.markWrap}>
              <AgentMark definition={byKind.pantheo} size={42} />
              <View
                style={[
                  styles.markDot,
                  {
                    backgroundColor: !connection.enabled
                      ? colors.faint
                      : connection.status?.connected
                        ? colors.green
                        : colors.red,
                  },
                ]}
              />
            </View>
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>{connection.name}</Text>
              <Text numberOfLines={1} style={styles.rowMeta}>
                {connection.url}
              </Text>
              <Text
                numberOfLines={connection.status?.last_error ? 2 : undefined}
                style={[
                  styles.rowMeta,
                  connection.enabled &&
                    connection.status?.last_error &&
                    styles.rowError,
                ]}
              >
                {!connection.enabled
                  ? "Disabled"
                  : connection.status?.connected
                    ? connection.status.agents.length
                      ? `${connection.status.agents.length} agent${connection.status.agents.length === 1 ? "" : "s"}`
                      : "Connected, registering…"
                    : connection.status?.last_error || "Connecting…"}
              </Text>
            </View>
            <Switch
              value={connection.enabled}
              accessibilityLabel={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`}
              onValueChange={(enabled) =>
                connectionMutations.update.mutate(
                  { name: connection.name, enabled },
                  { onError: (e) => toastErr("Update failed", e) },
                )
              }
              trackColor={{ false: colors.faint, true: colors.a1 }}
            />
          </View>
          <View style={styles.rowFooterEnd}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Manage DM access for ${connection.name}`} style={styles.manageButton} onPress={()=>manageSource("pantheo",connection.name)}><Text style={styles.manageText}>Manage access</Text></Pressable>
            <ArmedButton
              label="Remove"
              accessibilityLabel={`Remove ${connection.name}`}
              onConfirm={() =>
                connectionMutations.remove.mutate(connection.name, {
                  onError: (e) => toastErr("Remove failed", e),
                })
              }
            />
          </View>
        </View>
      ))}
      {connections.isError && !connections.data ? (
        <Text style={styles.empty}>Couldn't load linked instances.</Text>
      ) : connections.isSuccess && !connections.data.length ? (
        <Text style={styles.empty}>No linked instances yet.</Text>
      ) : null}
      <Text style={styles.sectionTitle}>Connected agents</Text>
      {(pairing.data ?? []).map((token) => {
        const definition = definitionFor(token);
        return (
          <View key={token.token} style={styles.row}>
            <View style={styles.rowTop}>
              <View style={styles.markWrap}>
                <AgentMark definition={definition} size={42} />
                <View
                  style={[
                    styles.markDot,
                    {
                      backgroundColor: token.connected
                        ? colors.green
                        : colors.faint,
                    },
                  ]}
                />
              </View>
              <View style={styles.rowMain}>
                <View style={styles.nameLine}>
                  <Text style={styles.rowName}>{token.name}</Text>
                  <Text style={styles.kindBadge}>
                    {definition?.shortTitle ?? "Agent"}
                  </Text>
                </View>
                <Text style={styles.rowMeta}>
                  {token.connected
                    ? token.agents?.map((a) => a.name || a.id).join(", ") ||
                      "Connected, registering…"
                    : "Offline"}
                </Text>
                <Text style={styles.rowMeta}>
                  Created {fmtTs(token.created_at)}
                </Text>
              </View>
            </View>
            <View style={styles.rowFooter}>
              <View style={styles.tokenActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Copy ${token.name} token`}
                  style={styles.tokenButton}
                  onPress={() =>
                    void Clipboard.setStringAsync(token.token)
                      .then(() => toast("Token copied"))
                      .catch((error) => toastErr("Couldn't copy token", error))
                  }
                >
                  <Text numberOfLines={1} style={styles.token}>
                    {token.token.slice(0, 10)}…{token.token.slice(-4)} · copy
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Share ${token.name} token`}
                  style={styles.iconButton}
                  onPress={() =>
                    void Share.share({ message: token.token }).catch((error) =>
                      toastErr("Couldn't share token", error),
                    )
                  }
                >
                  <Share2 size={15} color={colors.a1} />
                </Pressable>
              </View>
              <ArmedButton
                label="Revoke"
                accessibilityLabel={`Revoke access for ${token.name}`}
                onConfirm={() =>
                  pairingMutations.revoke.mutate(token.token, {
                    onError: (e) => toastErr("Revoke failed", e),
                  })
                }
              />
              <Pressable accessibilityRole="button" accessibilityLabel={`Manage DM access for ${token.name}`} style={styles.manageButton} onPress={()=>manageSource("pairing",token.id)}><Text style={styles.manageText}>Manage access</Text></Pressable>
            </View>
          </View>
        );
      })}
      {pairing.isError && !pairing.data ? (
        <Text style={styles.empty}>Couldn't load agent access.</Text>
      ) : pairing.isSuccess && !pairing.data.length ? (
        <Text style={styles.empty}>No agent access created yet.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flow: { gap: 14 },
  backRow:{minHeight:44,flexDirection:"row",alignItems:"center",gap:4},
  accessBackText:{color:colors.a1,fontSize:14,fontWeight:"700"},
  accessHeading:{color:colors.text,fontSize:21,fontWeight:"800",marginTop:4},
  accessHeader:{flexDirection:"row",alignItems:"center",gap:12,marginBottom:2},
  accessStatus:{color:colors.dim,fontSize:12.5,lineHeight:18},
  accessSectionHead:{gap:5,marginTop:4},
  accessHint:{color:colors.dim,fontSize:12.5,lineHeight:18},
  accessSwitch:{flexDirection:"row",alignItems:"center",gap:12,padding:14,borderWidth:1,borderColor:colors.border,borderRadius:12,backgroundColor:colors.panel},
  accessUser:{minHeight:58,flexDirection:"row",alignItems:"center",gap:12,paddingHorizontal:14,borderWidth:1,borderColor:colors.border,borderRadius:12,backgroundColor:colors.panel},
  checkText:{color:colors.a1,fontSize:20,fontWeight:"700"},
  accessAgentRow:{minHeight:58,flexDirection:"row",alignItems:"center",gap:12,padding:14,borderWidth:1,borderColor:colors.border,borderRadius:12,backgroundColor:colors.panel},
  accessDot:{width:10,height:10,borderRadius:5},
  manageButton:{minHeight:44,justifyContent:"center",paddingHorizontal:10},
  manageText:{color:colors.a1,fontSize:12.5,fontWeight:"700"},
  intro: { gap: 5 },
  kicker: {
    color: colors.a2,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  hero: { color: colors.text, fontSize: 20, lineHeight: 26, fontWeight: "800" },
  heroSmall: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "800",
  },
  heroCopy: { color: colors.dim, fontSize: 14.5, lineHeight: 21 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  card: {
    width: "100%",
    minHeight: 164,
    padding: 16,
    gap: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.panelStrong,
  },
  cardWide: { width: "48.8%" },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  localBadge: {
    alignSelf: "flex-start",
    color: colors.a2,
    fontSize: 10.5,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: "rgba(56,225,200,0.28)",
    backgroundColor: "rgba(56,225,200,0.08)",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 99,
  },
  cardTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "800", flex: 1 },
  cardDescription: { color: colors.dim, fontSize: 13.5, lineHeight: 19 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  logoStack: { flexDirection: "row", gap: 6 },
  fallbackMark: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(56,225,200,0.08)",
    borderWidth: 1,
    borderColor: "rgba(56,225,200,0.18)",
  },
  back: {
    minHeight: 44,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  backText: { color: colors.a1, fontSize: 13.5, fontWeight: "700" },
  setupHead: { flexDirection: "row", alignItems: "center", gap: 14 },
  setupTitle: { flex: 1, gap: 3 },
  guideLink: {
    flexDirection: "row",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: 5,
    minHeight: 40,
  },
  form: {
    gap: 8,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
  },
  label: { color: colors.dim, fontSize: 12.5, fontWeight: "700", marginTop: 3 },
  input: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: 13,
    fontSize: 15,
  },
  primary: {
    minHeight: 48,
    marginTop: 6,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    paddingHorizontal: 16,
  },
  primaryText: { color: colors.onAccent, fontSize: 14.5, fontWeight: "800" },
  disabled: { opacity: 0.45 },
  secondary: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: colors.dim, fontSize: 14, fontWeight: "700" },
  note: { color: colors.dim, fontSize: 12.5, lineHeight: 18 },
  security: {
    flexDirection: "row",
    gap: 9,
    padding: 13,
    borderRadius: 12,
    backgroundColor: "rgba(56,225,200,0.06)",
    borderWidth: 1,
    borderColor: "rgba(56,225,200,0.16)",
  },
  securityText: { flex: 1, color: colors.dim, fontSize: 12.5, lineHeight: 18 },
  success: { gap: 14, alignItems: "stretch", paddingVertical: 20 },
  successMark: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.a2,
    alignItems: "center",
    justifyContent: "center",
  },
  credential: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 54,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.panelStrong,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  credentialText: { ...mono, color: colors.text, fontSize: 12, flex: 1 },
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    marginTop: 4,
  },
  row: {
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowFooter: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingLeft: 54,
  },
  rowFooterEnd: {
    minHeight: 44,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: "700" },
  rowMeta: { color: colors.dim, fontSize: 11.5 },
  rowError: { color: colors.red },
  markWrap: { position: "relative" },
  markDot: {
    position: "absolute",
    right: -3,
    bottom: -3,
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 7 },
  kindBadge: {
    color: colors.a2,
    fontSize: 9.5,
    fontWeight: "800",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 99,
    backgroundColor: "rgba(56,225,200,0.08)",
  },
  tokenActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  tokenButton: {
    minHeight: 44,
    justifyContent: "center",
    flexShrink: 1,
    minWidth: 0,
  },
  token: { ...mono, color: colors.a1, fontSize: 10.5 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 18 },
});
