/* Members pane (.agora-members-pane): one row per person, agents collapsed to one row with scope tags, and the
   admin add-person / add-agent pickers. Channel view defaults when a channel is selected, with a
   #channel / Whole group switch so the full roster stays reachable. */

import { useEffect, useMemo, useState } from "react";
import {
  canManageMembershipScope,
  hasChannelScope,
  membershipUsernames,
  personRemovalTargets,
  useAddMember, useAgents, useGroups, useMe, useMembers, useRemoveMember,
  useUsers, visibleMembershipScopes, type AgentInfo, type Member, type UserInfo,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useConfirm } from "../state/confirm";
import { useUiState } from "../state/ui";
import { AgentAvatar } from "./AgentAvatar";

type RosterMode = "channel" | "group";
type AddPersonStep = { kind: "pick" } | { kind: "scope"; user: UserInfo } | { kind: "role"; user: UserInfo; channelId: string | null; scopeName: string };
type AddAgentStep = { kind: "pick" } | { kind: "scope"; agent: AgentInfo };

function ArmedRemove({
  armKey,
  label,
  title,
  onConfirm,
}: {
  armKey: string;
  label: string;
  title: string;
  onConfirm: () => void;
}) {
  const armed = useConfirm(s => s.armed) === armKey;
  const arm = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);
  return (
    <button
      type="button"
      className={`ago-inline-remove ${armed ? "armed" : ""}`}
      title={armed ? "Click again to confirm" : title}
      onClick={() => {
        if (!armed) { arm(armKey); return; }
        disarm();
        onConfirm();
      }}
    >
      {armed ? "Sure?" : label}
    </button>
  );
}

function RoleSelect({
  value,
  onChange,
}: {
  value: "admin" | "member";
  onChange: (role: "admin" | "member") => void;
}) {
  return (
    <select
      className="ago-role-select"
      value={value}
      aria-label="Membership role"
      onChange={e => onChange(e.target.value === "admin" ? "admin" : "member")}
    >
      <option value="member">Member</option>
      <option value="admin">Admin</option>
    </select>
  );
}

export function MembersPanel() {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  const g = groups.find(x => x.id === ui.sel.g);
  const members = useMembers(g?.id || "").data || [];
  const agents = useAgents().data || [];
  const users = useUsers().data || [];
  const add = useAddMember(g?.id || "");
  const remove = useRemoveMember(g?.id || "");
  const [rosterMode, setRosterMode] = useState<RosterMode>("channel");
  const [addPerson, setAddPerson] = useState<AddPersonStep | null>(null);
  const [addAgent, setAddAgent] = useState<AddAgentStep | null>(null);

  const selectedChannel = g?.channels.find(c => c.id === ui.sel.c);
  // Prefer channel-focused roster when a channel is selected; fall back to group.
  useEffect(() => {
    setRosterMode(ui.sel.c ? "channel" : "group");
    setAddPerson(null);
    setAddAgent(null);
  }, [ui.sel.c, ui.sel.g]);

  const admin = !!g && (g.role === "admin" || selectedChannel?.role === "admin" || !!me?.instance_admin);
  const groupAdmin = !!g && (g.role === "admin" || !!me?.instance_admin);
  const channelFocused = !!g && rosterMode === "channel" && !!ui.sel.c;
  const focusChannelId = channelFocused && ui.sel.c ? ui.sel.c : undefined;
  const liveById = Object.fromEntries(agents.map(a => [a.id, a.live]));

  const agentGroups = useMemo(() => {
    const byId = new Map<string, Member[]>();
    for (const m of members) {
      if (m.member_type !== "agent") continue;
      if (!byId.has(m.member_id)) byId.set(m.member_id, []);
      byId.get(m.member_id)!.push(m);
    }
    return [...byId.entries()].map(([id, scopes]) => ({
      id,
      scopes: visibleMembershipScopes(scopes, focusChannelId),
      name: scopes[0]?.name || id,
    })).filter(entry => entry.scopes.length > 0);
  }, [members, focusChannelId]);

  const peopleGroups = useMemo(() => {
    const byId = new Map<string, Member[]>();
    for (const m of members) {
      if (m.member_type !== "user") continue;
      if (!byId.has(m.member_id)) byId.set(m.member_id, []);
      byId.get(m.member_id)!.push(m);
    }
    return [...byId.entries()].map(([id, scopes]) => ({
      id,
      scopes: visibleMembershipScopes(scopes, focusChannelId),
      name: scopes[0]?.name || id,
    })).filter(entry => entry.scopes.length > 0);
  }, [members, focusChannelId]);

  if (!ui.membersOpen || !g) {
    return <div className="agora-members-pane" id="agora-members-pane" style={{ display: "none" }}></div>;
  }

  const chanName = (id: string | null | undefined) => {
    if (!id) return "whole group";
    const c = (g.channels || []).find(x => x.id === id);
    return c ? "#" + c.name : id;
  };

  const groupWideUsers = new Set(members.filter(m => m.member_type === "user" && !m.channel_id).map(m => m.member_id));
  const memberNames = membershipUsernames(
    members.filter(m => m.member_type === "user"),
    focusChannelId,
  );
  const addableUsers = users.filter(u => !u.disabled && !(focusChannelId ? memberNames.has(u.username) : groupWideUsers.has(u.username)));
  const groupWideAgents = new Set(members.filter(m => m.member_type === "agent" && !m.channel_id).map(m => m.member_id));
  const addableAgents = agents.filter(a => !groupWideAgents.has(a.id));
  const scopeChannels = groupAdmin
    ? g.channels
    : g.channels.filter(c => c.id === ui.sel.c);

  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  const canManage = (scope: Member) =>
    // Use the selected channel (not roster mode) so channel admins keep
    // controls on their own channel rows when viewing Whole group.
    canManageMembershipScope(scope, groupAdmin, ui.sel.c ?? undefined, !!admin);

  const removeScope = (memberType: "user" | "agent", memberId: string, channelId: string | null) => {
    remove.mutate(
      { member_type: memberType, member_id: memberId, channel_id: channelId || undefined },
      { onError: err("Couldn't remove member") },
    );
  };

  const leaveSelf = async (scopes: Member[], forceAll: boolean) => {
    try {
      for (const target of personRemovalTargets(scopes, forceAll ? undefined : focusChannelId)) {
        await remove.mutateAsync({ member_type: "user", ...target });
      }
    } catch (e) {
      err("Couldn't leave")(e);
    }
  };

  const setRole = (memberId: string, role: "admin" | "member", channelId: string | null) => {
    add.mutate(
      { member_type: "user", member_id: memberId, role, channel_id: channelId || undefined },
      { onError: err("Couldn't change role") },
    );
  };

  const submitPerson = (user: UserInfo, role: "admin" | "member", channelId: string | null) => {
    add.mutate(
      { member_type: "user", member_id: user.username, role, channel_id: channelId || (groupAdmin ? undefined : ui.sel.c || undefined) },
      {
        onSuccess: () => {
          toast(`${user.display_name || user.username} added to ${g.name}`, { variant: "ok" });
          setAddPerson(null);
        },
        onError: err("Couldn't add person"),
      },
    );
  };

  const submitAgent = (agent: AgentInfo, channelId: string | null) => {
    add.mutate(
      { member_type: "agent", member_id: agent.id, channel_id: channelId || (groupAdmin ? undefined : ui.sel.c || undefined) },
      {
        onSuccess: () => {
          if (!agent.live) {
            toast(`${agent.name} joined, but it's offline right now — it will answer once its connection is live.`, { variant: "warn" });
          } else {
            toast(`${agent.name} added — it will answer messages here.`, { variant: "ok" });
          }
          setAddAgent(null);
        },
        onError: err("Couldn't add agent"),
      },
    );
  };

  return (
    <div className="agora-members-pane" id="agora-members-pane">
      <div className="ago-head">
        <div className="ago-head-text">
          <span className="ago-chan-name">Members</span>
          <span className="dim">{channelFocused && selectedChannel ? `#${selectedChannel.name}` : g.name}</span>
        </div>
        <button className="btn sm" title="Close members" onClick={() => ui.setMembersOpen(false)}>
          <Icon name="x" />
        </button>
      </div>
      {ui.sel.c ? (
        <div className="ago-members-mode" role="tablist" aria-label="Members roster scope">
          <button
            type="button"
            role="tab"
            aria-selected={rosterMode === "channel"}
            className={rosterMode === "channel" ? "active" : ""}
            onClick={() => setRosterMode("channel")}
          >
            #{selectedChannel?.name ?? "channel"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={rosterMode === "group"}
            className={rosterMode === "group" ? "active" : ""}
            onClick={() => setRosterMode("group")}
          >
            Whole group
          </button>
        </div>
      ) : null}
      <div className="ago-members-body">
        <div className="ago-member-list">
          {peopleGroups.length === 0 && agentGroups.length === 0
            ? <div className="dim" style={{ padding: "6px 0", fontSize: 12 }}>No members yet.</div>
            : null}
          {peopleGroups.map(person => {
            const self = !!me && person.id === me.username;
            const hasSelected = hasChannelScope(person.scopes, focusChannelId);
            const leaveInherited = self && channelFocused && !hasSelected;
            return (
              <div key={`u-${person.id}`} className="ago-member ago-member-card">
                <div className="ago-member-identity">
                  <span className="ago-av sm"><Icon name="user" /></span>
                  <span className="mname">{person.name}{self ? <> <span className="dim">· you</span></> : null}</span>
                  {self && (!channelFocused || leaveInherited) ? (
                    <ArmedRemove
                      armKey={`leave:${person.id}:${focusChannelId ?? "group"}`}
                      label={leaveInherited ? `Leave ${g.name}` : "Leave"}
                      title={leaveInherited ? `Leave ${g.name}` : "Leave this group"}
                      onConfirm={() => void leaveSelf(person.scopes, leaveInherited || !channelFocused)}
                    />
                  ) : null}
                </div>
                <div className="ago-scope-list">
                  {person.scopes.map((scope, si) => {
                    const manageable = canManage(scope);
                    const shadowed = !!scope.channel_id && person.scopes.some(candidate => !candidate.channel_id);
                    const wholeGroupContext = channelFocused && !scope.channel_id;
                    // Shadowed channel rows inherit whole-group access — removing
                    // them is a no-op, so suppress the armed action and show why.
                    const channelAction = channelFocused && !!scope.channel_id && !shadowed && (manageable || self);
                    const actionLabel = self ? "Leave" : "Remove";
                    return (
                      <div key={si} className="ago-scope-row">
                        <div className={channelAction ? "ago-inline-remove-row" : "ago-scope-main"}>
                          <span className={`ago-scope-tag ${wholeGroupContext || shadowed ? "muted" : ""}`}>
                            <span className="ago-scope-label">{scope.channel_id ? chanName(scope.channel_id) : "whole group"}</span>
                            {!channelFocused && manageable ? (
                              <button className="ago-tag-x" title="Remove this access"
                                onClick={() => removeScope("user", person.id, scope.channel_id)}>
                                <Icon name="x" />
                              </button>
                            ) : null}
                          </span>
                          {channelAction ? (
                            <ArmedRemove
                              armKey={`rm:user:${person.id}:${scope.channel_id}`}
                              label={actionLabel}
                              title={`${actionLabel} ${self ? "" : person.name + " "}from this channel`}
                              onConfirm={() => removeScope("user", person.id, scope.channel_id)}
                            />
                          ) : null}
                        </div>
                        {manageable && !shadowed && !wholeGroupContext ? (
                          <RoleSelect
                            value={scope.role === "admin" ? "admin" : "member"}
                            onChange={role => setRole(person.id, role, scope.channel_id)}
                          />
                        ) : (
                          <span className="mmeta short">
                            {scope.role}
                            {shadowed ? " · included in whole-group access" : ""}
                            {wholeGroupContext ? " · inherited" : ""}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {agentGroups.map(agent => {
            const off = liveById[agent.id] === false;
            const agentInfo = agents.find(a => a.id === agent.id);
            return (
              <div key={`a-${agent.id}`} className="ago-member ago-member-card ago-agent">
                <div className="ago-member-identity">
                  <AgentAvatar avatar={agentInfo?.avatar} small />
                  <span className="mname">{agent.name}</span>
                  <span className="mmeta short">
                    member{off ? <> · <span className="ago-off" title="Offline — won’t reply">offline</span></> : null}
                  </span>
                </div>
                <div className="ago-scope-list">
                  {agent.scopes.map((scope, si) => {
                    const manageable = canManage(scope);
                    const shadowed = !!scope.channel_id && agent.scopes.some(candidate => !candidate.channel_id);
                    const wholeGroupContext = channelFocused && !scope.channel_id;
                    const channelAction = channelFocused && !!scope.channel_id && manageable && !shadowed;
                    return (
                      <div key={si} className="ago-scope-row">
                        <div className={channelAction || channelFocused ? "ago-inline-remove-row" : "ago-scope-main"}>
                          <span className={`ago-scope-tag ${wholeGroupContext || shadowed ? "muted" : ""}`}>
                            <span className="ago-scope-label">{scope.channel_id ? chanName(scope.channel_id) : "whole group"}</span>
                            {!channelFocused && manageable ? (
                              <button className="ago-tag-x"
                                title={`Stop listening ${scope.channel_id ? "in " + chanName(scope.channel_id) : "group-wide"}`}
                                onClick={() => removeScope("agent", agent.id, scope.channel_id)}>
                                <Icon name="x" />
                              </button>
                            ) : null}
                          </span>
                          {channelAction ? (
                            <ArmedRemove
                              armKey={`rm:agent:${agent.id}:${scope.channel_id}`}
                              label="Remove"
                              title={`Remove ${agent.name} from this channel`}
                              onConfirm={() => removeScope("agent", agent.id, scope.channel_id)}
                            />
                          ) : null}
                        </div>
                        {shadowed ? <span className="mmeta short">included in whole-group access</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {admin && (
          <>
            <div className="ago-member-add-flow">
              {!addPerson ? (
                <button type="button" className="ago-add-link" onClick={() => setAddPerson({ kind: "pick" })}>
                  ＋ Add person
                </button>
              ) : addPerson.kind === "pick" ? (
                <div className="ago-add-box">
                  <div className="ago-add-title">Pick a person</div>
                  {addableUsers.length === 0
                    ? <p className="ago-member-hint">Everyone in the workspace is already in this roster.</p>
                    : addableUsers.map(u => (
                      <button key={u.username} type="button" className="ago-add-option"
                        onClick={() => setAddPerson({ kind: "scope", user: u })}>
                        <span>{u.display_name || u.username}</span>
                        <span className="dim">{u.username}</span>
                      </button>
                    ))}
                  <button type="button" className="ago-add-cancel" onClick={() => setAddPerson(null)}>Cancel</button>
                </div>
              ) : addPerson.kind === "scope" ? (
                <div className="ago-add-box">
                  <div className="ago-add-title">Where should {addPerson.user.display_name || addPerson.user.username} have access?</div>
                  {groupAdmin ? (
                    <button type="button" className="ago-add-option"
                      onClick={() => setAddPerson({ kind: "role", user: addPerson.user, channelId: null, scopeName: "Whole group" })}>
                      Whole group
                    </button>
                  ) : null}
                  {scopeChannels.map(c => (
                    <button key={c.id} type="button" className="ago-add-option"
                      onClick={() => setAddPerson({ kind: "role", user: addPerson.user, channelId: c.id, scopeName: `#${c.name}` })}>
                      #{c.name}
                    </button>
                  ))}
                  <button type="button" className="ago-add-cancel" onClick={() => setAddPerson({ kind: "pick" })}>‹ Back</button>
                </div>
              ) : (
                <div className="ago-add-box">
                  <div className="ago-add-title">Choose a role for {addPerson.scopeName}</div>
                  <button type="button" className="ago-add-option" disabled={add.isPending}
                    onClick={() => submitPerson(addPerson.user, "member", addPerson.channelId)}>
                    <span>Member</span><span className="dim">Can read and participate</span>
                  </button>
                  <button type="button" className="ago-add-option" disabled={add.isPending}
                    onClick={() => submitPerson(addPerson.user, "admin", addPerson.channelId)}>
                    <span>Admin</span><span className="dim">Can also manage this access</span>
                  </button>
                  <button type="button" className="ago-add-cancel"
                    onClick={() => setAddPerson({ kind: "scope", user: addPerson.user })}>‹ Back</button>
                </div>
              )}
            </div>
            <div className="ago-member-add-flow">
              {!addAgent ? (
                <button type="button" className="ago-add-link" onClick={() => setAddAgent({ kind: "pick" })}>
                  ＋ Add agent
                </button>
              ) : addAgent.kind === "pick" ? (
                <div className="ago-add-box">
                  <div className="ago-add-title">Pick an agent</div>
                  {addableAgents.length === 0
                    ? <p className="ago-member-hint">No agents available, or every agent already listens group-wide.</p>
                    : addableAgents.map(a => (
                      <button key={a.id} type="button" className="ago-add-option"
                        onClick={() => setAddAgent({ kind: "scope", agent: a })}>
                        <span>{a.name}{a.live ? "" : " (offline)"}</span>
                      </button>
                    ))}
                  <button type="button" className="ago-add-cancel" onClick={() => setAddAgent(null)}>Cancel</button>
                </div>
              ) : (
                <div className="ago-add-box">
                  <div className="ago-add-title">Where should {addAgent.agent.name} listen?</div>
                  {groupAdmin ? (
                    <button type="button" className="ago-add-option" disabled={add.isPending}
                      onClick={() => submitAgent(addAgent.agent, null)}>
                      Whole group
                    </button>
                  ) : null}
                  {scopeChannels.map(c => (
                    <button key={c.id} type="button" className="ago-add-option" disabled={add.isPending}
                      onClick={() => submitAgent(addAgent.agent, c.id)}>
                      #{c.name}
                    </button>
                  ))}
                  <button type="button" className="ago-add-cancel" onClick={() => setAddAgent({ kind: "pick" })}>‹ Back</button>
                </div>
              )}
            </div>
            <p className="ago-member-hint">
              No agents in the list? Link a Pantheo instance or pair a bridge under <b>Connections</b> first.
              Scope an agent to one channel, or give it the whole group.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
