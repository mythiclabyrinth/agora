/* Agent avatar shared by messages, members, and the agents list: the picture
   proxied from the agent's home instance (AgentInfo.avatar from /api/agents),
   falling back to the bot icon when the agent has none or the load fails. */

import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { Bot } from "lucide-react-native";
import { authHeaders } from "@agora/core";
import { useAgents } from "@agora/core";
import { useSession } from "../state/session";
import { colors } from "../lib/theme";
import { Icon } from "./Icon";

export function AgentAvatar({ agentId, size = 30 }: { agentId: string; size?: number }) {
  const session = useSession((s) => s.session);
  const agents = useAgents();
  const [failed, setFailed] = useState(false);
  const avatar = (agents.data ?? []).find((a) => a.id === agentId)?.avatar ?? null;
  const box = { width: size, height: size, borderRadius: size * 0.3 };

  if (session && avatar && !failed) {
    return (
      <Image
        source={{ uri: `${session.baseUrl}${avatar}`, headers: authHeaders(session) }}
        style={[styles.image, box]}
        contentFit="cover"
        transition={100}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View style={[styles.fallback, box]}>
      <Icon icon={Bot} size={size * 0.55} color={colors.a1} />
    </View>
  );
}

const styles = StyleSheet.create({
  image: { backgroundColor: colors.panelStrong },
  fallback: {
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
});
