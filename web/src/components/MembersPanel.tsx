/* Members pane (.agora-members-pane): one row per person, agents collapsed to one row with scope tags, and the
   admin add-person / add-agent pickers. */

import { useState } from "react";
import {
  useAddMember, useAgents, useGroups, useMe, useMembers, useRemoveMember,
  useUsers, type Member,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";
import { AgentAvatar } from "./AgentAvatar";

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
  const [addUser, setAddUser] = useState("");
  const [addUserRole, setAddUserRole] = useState("member");
  const [addUserChan, setAddUserChan] = useState("");
  const [addAgent, setAddAgent] = useState("");
  const [addAgentChan, setAddAgentChan] = useState("");

  if (!ui.membersOpen || !g) {
    return <div className="agora-members-pane" id="agora-members-pane" style={{ display: "none" }}></div>;
  }

  const selectedChannel = g.channels.find(c => c.id === ui.sel.c);
  const admin = g.role === "admin" || selectedChannel?.role === "admin" || !!me?.instance_admin;
  const groupAdmin = g.role === "admin" || !!me?.instance_admin;
  const chanName = (id: string) => {
    const c = (g.channels || []).find(x => x.id === id);
    return c ? "#" + c.name : id;
  };
  const liveById = Object.fromEntries(agents.map(a => [a.id, a.live]));

  // One row per agent: collapse multi-channel scopes into tags.
  const agentScopes = new Map<string, Member[]>();
  for (const m of members) {
    if (m.member_type !== "agent") continue;
    if (!agentScopes.has(m.member_id)) agentScopes.set(m.member_id, []);
    agentScopes.get(m.member_id)!.push(m);
  }
  const drawnAgents = new Set<string>();

  const userScopes = new Map<string, Member[]>();
  for (const m of members) {
    if (m.member_type !== "user") continue;
    if (!userScopes.has(m.member_id)) userScopes.set(m.member_id, []);
    userScopes.get(m.member_id)!.push(m);
  }
  const drawnUsers = new Set<string>();

  const groupWideUsers = new Set(members.filter(m => m.member_type === "user" && !m.channel_id).map(m => m.member_id));
  const addableUsers = users.filter(u => !u.disabled && !groupWideUsers.has(u.username));

  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  return (
    <div className="agora-members-pane" id="agora-members-pane">
      <div className="ago-head">
        <div className="ago-head-text">
          <span className="ago-chan-name">Members</span>
          <span className="dim">{g.name}</span>
        </div>
        <button className="btn sm" title="Close members" onClick={() => ui.setMembersOpen(false)}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ago-members-body">
        <div className="ago-member-list">
          {members.length ? members.map((m, mi) => {
            if (m.member_type === "agent") {
              if (drawnAgents.has(m.member_id)) return null;
              drawnAgents.add(m.member_id);
              const off = liveById[m.member_id] === false;
              const agent = agents.find(a => a.id === m.member_id);
              const scopes = agentScopes.get(m.member_id) || [m];
              return (
                <div key={`a-${m.member_id}`} className="ago-member ago-agent">
                  <AgentAvatar avatar={agent?.avatar} small />
                  <span className="mname">{m.name || m.member_id}</span>
                  <span className="mmeta short">
                    {m.role}{off ? <> · <span className="ago-off" title="Offline — won’t reply">offline</span></> : null}
                  </span>
                  <span className="ago-scope-tags">
                    {scopes.map((s, si) => (
                      <span key={si} className="ago-scope-tag">
                        {s.channel_id ? chanName(s.channel_id) : "whole group"}
                        {(groupAdmin || (!!s.channel_id && s.channel_id === ui.sel.c && admin)) && (
                          <button className="ago-tag-x"
                            title={`Stop listening ${s.channel_id ? "in " + chanName(s.channel_id) : "group-wide"}`}
                            onClick={() => remove.mutate(
                              { member_type: "agent", member_id: m.member_id, channel_id: s.channel_id || null },
                              { onError: err("Couldn't remove member") },
                            )}>
                            <Icon name="x" />
                          </button>
                        )}
                      </span>
                    ))}
                  </span>
                  {groupAdmin && (
                    <button className="ago-x" title="Remove from the whole group"
                      onClick={() => {
                        for (const s of scopes) {
                          remove.mutate(
                            { member_type: "agent", member_id: m.member_id, channel_id: s.channel_id || null },
                            { onError: err("Couldn't remove member") },
                          );
                        }
                      }}>
                      <Icon name="x" />
                    </button>
                  )}
                </div>
              );
            }
            if (drawnUsers.has(m.member_id)) return null;
            drawnUsers.add(m.member_id);
            const self = !!me && m.member_id === me.username;
            const scopes = userScopes.get(m.member_id) || [m];
            return (
              <div key={`u-${m.member_id}-${mi}`} className="ago-member">
                <span className="ago-av sm"><Icon name="user" /></span>
                <span className="mname">{m.name || m.member_id}{self ? <> <span className="dim">· you</span></> : null}</span>
                <span className="ago-scope-tags">
                  {scopes.map((scope, si) => {
                    const canManage = groupAdmin || (!!scope.channel_id && scope.channel_id === ui.sel.c && admin);
                    return <span key={si} className="ago-scope-tag">
                      {scope.channel_id ? chanName(scope.channel_id) : "whole group"} · {scope.role}
                      {canManage && <button className="ago-tag-x" title="Remove this access"
                        onClick={() => remove.mutate({ member_type: "user", member_id: m.member_id, channel_id: scope.channel_id || undefined }, { onError: err("Couldn't remove member") })}>
                        <Icon name="x" />
                      </button>}
                      {canManage && <button className="ago-tag-x" title={scope.role === "admin" ? "Make member" : "Make admin"}
                        onClick={() => add.mutate({ member_type: "user", member_id: m.member_id, role: scope.role === "admin" ? "member" : "admin", channel_id: scope.channel_id || undefined }, { onError: err("Couldn't change role") })}>
                        <Icon name={scope.role === "admin" ? "arrow-down" : "arrow-up"} />
                      </button>}
                    </span>;
                  })}
                </span>
                {(groupAdmin || self) && (
                  <button className="ago-x" title={self && !groupAdmin ? "Leave this group" : "Remove all access"}
                    onClick={() => remove.mutate(
                      { member_type: m.member_type, member_id: m.member_id, all_scopes: true },
                      { onError: err("Couldn't remove member") },
                    )}>
                    <Icon name="x" />
                  </button>
                )}
              </div>
            );
          }) : <div className="dim" style={{ padding: "6px 0", fontSize: 12 }}>No members yet.</div>}
        </div>
        {admin && (
          <>
            <div className="ago-member-add ago-person-add">
              <select id="ago-add-user" value={addUser} onChange={e => setAddUser(e.target.value)}>
                {addableUsers.length
                  ? <><option value="">pick a person…</option>{addableUsers.map(u => (
                    <option key={u.username} value={u.username}>{u.display_name || u.username}</option>
                  ))}</>
                  : <option value="">everyone’s already here</option>}
              </select>
              <select id="ago-add-user-role" value={addUserRole} onChange={e => setAddUserRole(e.target.value)}>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <select id="ago-add-user-chan" value={addUserChan} onChange={e => setAddUserChan(e.target.value)}>
                {groupAdmin && <option value="">whole group</option>}
                {(g.channels || []).filter(c => groupAdmin || c.id === ui.sel.c).map(c => (
                  <option key={c.id} value={c.id}>#{c.name}</option>
                ))}
              </select>
              <button className="btn sm" onClick={() => {
                if (!addUser) return;
                add.mutate({ member_type: "user", member_id: addUser, role: addUserRole, channel_id: addUserChan || (groupAdmin ? undefined : ui.sel.c || undefined) }, {
                  onSuccess: () => toast(`${addUser} added to ${g.name}`, { variant: "ok" }),
                  onError: err("Couldn't add person"),
                });
                setAddUser("");
              }}>Add person</button>
            </div>
            <div className="ago-member-add">
              <select id="ago-add-agent" value={addAgent} onChange={e => setAddAgent(e.target.value)}>
                {agents.length
                  ? <><option value="">pick an agent…</option>{agents.map(a => (
                    <option key={a.id} value={a.id}>{a.name}{a.live ? "" : " (offline)"}</option>
                  ))}</>
                  : <option value="">no agents yet</option>}
              </select>
              <select id="ago-add-agent-chan" value={addAgentChan} onChange={e => setAddAgentChan(e.target.value)}>
                {groupAdmin && <option value="">whole group</option>}
                {(g.channels || []).filter(c => groupAdmin || c.id === ui.sel.c).map(c => (
                  <option key={c.id} value={c.id}>#{c.name}</option>
                ))}
              </select>
              <button className="btn sm" onClick={() => {
                if (!addAgent) return;
                const picked = agents.find(a => a.id === addAgent);
                add.mutate({ member_type: "agent", member_id: addAgent, channel_id: addAgentChan || (groupAdmin ? undefined : ui.sel.c || undefined) }, {
                  onSuccess: () => {
                    if (picked && !picked.live) {
                      toast(`${picked.name} joined, but it's offline right now — it will answer once its connection is live.`, { variant: "warn" });
                    } else if (picked) {
                      toast(`${picked.name} added — it will answer messages here.`, { variant: "ok" });
                    }
                  },
                  onError: err("Couldn't add agent"),
                });
                setAddAgent("");
              }}>Add agent</button>
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
