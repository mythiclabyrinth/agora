/* People & invites overlay (#users-panel): workspace accounts with role/disable controls, email invites, and
   single-use invite links. Admin only. */

import { useState } from "react";
import {
  useCreateInvite, useInvites, useMe, useRevokeInvite, useUpdateUser, useUsers,
  type InviteLink,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

export function PeoplePane() {
  const ui = useUiState();
  const me = useMe().data;
  const open = ui.panel === "people";
  const users = useUsers(open).data || [];
  const invitesQ = useInvites(open).data;
  const invites = invitesQ?.invites || [];
  const links = invitesQ?.links || [];
  const updateUser = useUpdateUser();
  const createInvite = useCreateInvite();
  const revokeInvite = useRevokeInvite();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [linkRole, setLinkRole] = useState("member");

  if (!open) return null;
  const now = Date.now() / 1000;
  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  return (
    <div className="conn-overlay" id="users-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.openPanel(null); }}>
      <div className="conn-panel" id="users-panel">
        <div className="conn-head">
          <b>People</b>
          <button className="btn sm" aria-label="Close people" onClick={() => ui.openPanel(null)}><Icon name="x" /></button>
        </div>
        <div className="conn-body">
          <h4>Users <span className="dim">— everyone with an account on this Agora</span></h4>
          {users.length ? users.map(u => {
            const self = u.username === me?.username;
            const admin = u.instance_role === "admin";
            return (
              <div key={u.username} className={`conn-row ${u.disabled ? "disabled" : ""}`}>
                <span className={`conn-dot ${u.disabled ? "err" : "on"}`}></span>
                <div className="conn-row-main">
                  <div className="conn-name">{u.display_name || u.username}{" "}
                    <span className="dim">@{u.username}{self ? " · you" : ""}</span></div>
                  <div className="conn-url">{u.email || "no email — admin-key bootstrap"} · {u.instance_role}{u.disabled ? " · disabled" : ""}</div>
                </div>
                {!self && (
                  <>
                    <button className="btn sm"
                      title={admin ? "Remove instance-admin powers" : "Make instance admin"}
                      onClick={() => updateUser.mutate(
                        { username: u.username, instance_role: admin ? "member" : "admin" },
                        { onError: err("Couldn't change role") },
                      )}>
                      {admin ? "Demote" : "Make admin"}
                    </button>
                    <button className={`btn sm ${u.disabled ? "" : "danger"}`}
                      title={u.disabled ? "Let this person sign in again" : "Block sign-in and revoke their sessions"}
                      onClick={() => updateUser.mutate(
                        { username: u.username, disabled: !u.disabled },
                        { onError: err("Couldn't update user") },
                      )}>
                      {u.disabled ? "Enable" : "Disable"}
                    </button>
                  </>
                )}
              </div>
            );
          }) : <div className="dim conn-empty">No users yet.</div>}

          <h4>Invites <span className="dim">— sign in with Google/Apple using the invited email to join</span></h4>
          {invites.length ? invites.map(i => (
            <div key={i.email} className="conn-row">
              <span className={`conn-dot ${i.accepted_at ? "on" : "off"}`}></span>
              <div className="conn-row-main">
                <div className="conn-name">{i.email}</div>
                <div className="conn-url">{i.instance_role} · {i.accepted_at ? "accepted" : "pending"}{i.invited_by ? ` · invited by ${i.invited_by}` : ""}</div>
              </div>
              {!i.accepted_at && (
                <button className="btn sm danger"
                  onClick={() => revokeInvite.mutate(i.email, { onError: err("Revoke failed") })}>
                  Revoke
                </button>
              )}
            </div>
          )) : <div className="dim conn-empty">No invites.</div>}
          <div className="conn-add">
            <input id="invite-email" type="email" placeholder="person@example.com"
              value={email} onChange={e => setEmail(e.target.value)} />
            <select id="invite-role" value={role} onChange={e => setRole(e.target.value)}>
              <option value="member">member</option>
              <option value="admin">instance admin</option>
            </select>
            <button className="btn sm primary" onClick={() => {
              const v = email.trim();
              if (!v) return;
              createInvite.mutate({ email: v, instance_role: role }, {
                onSuccess: () => setEmail(""),
                onError: err("Invite failed"),
              });
            }}>Invite</button>
          </div>
          <p className="conn-hint">No email is sent — share the address of this Agora yourself.
            The account is created when they first sign in; add them to groups from each
            group's <b>Members</b> panel.</p>

          <h4>Invite links <span className="dim">— single-use URLs, valid 7 days</span></h4>
          {links.length ? links.map(l => {
            const state = l.used_by ? `used by @${l.used_by}`
              : l.expires_at < now ? "expired"
              : `expires ${new Date(l.expires_at * 1000).toLocaleDateString()}`;
            const live = !l.used_by && l.expires_at >= now;
            return (
              <div key={l.token} className="conn-row">
                <span className={`conn-dot ${l.used_by ? "on" : live ? "off" : "err"}`}></span>
                <div className="conn-row-main">
                  <div className="conn-name">{l.token.slice(0, 8)}… <span className="dim">{l.instance_role}</span></div>
                  <div className="conn-url">{state}{l.invited_by ? ` · created by ${l.invited_by}` : ""}</div>
                </div>
                {live && (
                  <button className="btn sm" title="Copy the invite URL"
                    onClick={() => {
                      void navigator.clipboard.writeText(l.url).then(
                        () => toast("Invite link copied", { variant: "ok" }),
                        () => toast("Couldn't copy — copy it from the address instead", { variant: "warn" }),
                      );
                    }}>Copy link</button>
                )}
              </div>
            );
          }) : <div className="dim conn-empty">No invite links.</div>}
          <div className="conn-add">
            <select id="invite-link-role" value={linkRole} onChange={e => setLinkRole(e.target.value)}>
              <option value="member">member</option>
              <option value="admin">instance admin</option>
            </select>
            <button className="btn sm primary" onClick={() => {
              createInvite.mutate({ link: true, instance_role: linkRole }, {
                onSuccess: (res) => {
                  const url = (res as InviteLink).url;
                  if (url) {
                    void navigator.clipboard.writeText(url).then(
                      () => toast("Invite link created and copied", { variant: "ok" }),
                      () => toast("Invite link created", { variant: "ok" }),
                    );
                  }
                },
                onError: err("Couldn't create invite link"),
              });
            }}>Create invite link</button>
          </div>
          <p className="conn-hint">Anyone who opens the link and signs in with Google/Apple
            joins with the chosen role — hand it out over any channel you trust.</p>
        </div>
      </div>
    </div>
  );
}
