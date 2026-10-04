/* Group overview page: channel cards
   with unread badges and eye toggles, hide/show group, admin delete. */

import {
  useDeleteGroup, useGroups, useMe, useSetGroupHidden, useSetGroupPublic,
  useUpdateChannel,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useConfirm } from "../state/confirm";
import { useUiState } from "../state/ui";
import { copyDeepLink } from "../lib/deepLinks";

export function GroupOverview() {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  const g = groups.find(x => x.id === ui.sel.g);
  const deleteGroup = useDeleteGroup();
  const setHidden = useSetGroupHidden();
  const setPublic = useSetGroupPublic();
  const updateChannel = useUpdateChannel();
  const armed = useConfirm(s => s.armed) === `group:${g?.id}`;
  const arm = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);

  if (!g) {
    return <div className="agora-main" id="agora-main"></div>;
  }
  const admin = g.role === "admin" || !!me?.instance_admin;
  const desc = (g.description || "").trim();
  // Hidden channels are only discoverable in the dedicated Hidden section.
  const chans = (g.channels || []).filter(channel => !channel.hidden);

  return (
    <div className="agora-main" id="agora-main">
      <div className="ago-head">
        <button className="btn sm ago-back" title="Back to groups" onClick={() => ui.backToGroups()}>
          <Icon name="chevron-left" />
        </button>
        <div className="ago-head-text">
          <span className="ago-chan-name">{g.name}{g.is_public ? <span className="ago-hidden-tag">public</span> : null}{g.hidden ? <span className="ago-hidden-tag">hidden</span> : null}</span>
          <span className="dim">{chans.length} channel{chans.length === 1 ? "" : "s"}</span>
        </div>
        <div className="ago-head-actions">
          <button className="btn sm" title="Copy link to this group"
            onClick={() => void copyDeepLink({ kind: "group", groupId: g.id }, "Group")}>
            <Icon name="link" /> Link
          </button>
          <button className="btn sm"
            title={g.hidden
              ? "Bring this group back into your sidebar"
              : "Tuck this group away for you — everything stays intact, it just leaves your sidebar"}
            onClick={() => setHidden.mutate({ groupId: g.id, hidden: !g.hidden })}>
            <Icon name={g.hidden ? "eye" : "eye-off"} /> {g.hidden ? "Show group" : "Hide group"}
          </button>
          {admin && (
            <button className="btn sm"
              title={g.is_public
                ? "Make this group members-only again"
                : "Open this group to everyone with an account — no invite needed"}
              onClick={() => setPublic.mutate({ groupId: g.id, isPublic: !g.is_public }, {
                onSuccess: () => toast(g.is_public
                  ? `${g.name} is members-only again`
                  : `${g.name} is now public — every signed-in user can see and join in`),
                onError: e => toast("Couldn't change group visibility: " + (e as Error).message, { variant: "warn" }),
              })}>
              <Icon name={g.is_public ? "lock" : "globe"} /> {g.is_public ? "Make private" : "Make public"}
            </button>
          )}
          {admin && (
            <button className={`btn sm danger ${armed ? "armed" : ""}`}
              onClick={() => {
                if (!armed) { arm(`group:${g.id}`); return; }
                disarm();
                deleteGroup.mutate(g.id, {
                  onError: e => toast("Couldn't delete group: " + (e as Error).message, { variant: "warn" }),
                });
              }}>
              {armed ? "Sure? This deletes everything" : "Delete group"}
            </button>
          )}
        </div>
      </div>
      <div className="ago-log ago-inbox-list">
        {desc ? <div className="ago-gp-desc">{desc}</div> : null}
        {chans.length ? chans.map(c => {
          const unread = c.unread || 0;
          const mentionsN = c.mentions || 0;
          return (
            <div key={c.id}
              className={`ago-inbox-row ago-gp-chan ${unread || mentionsN ? "unread" : ""} ${c.hidden ? "is-hidden" : ""}`}
              title={`Open #${c.name}`}
              onClick={() => ui.selectChannel(g.id, c.id)}>
              <div className="ago-inbox-top">
                <span className="chan"><span className="hash">#</span>{c.name}{c.hidden ? <span className="ago-hidden-tag">hidden</span> : null}</span>
                <div className="ago-inbox-meta">
                  {mentionsN > 0
                    ? <span className="ago-unread-badge mention">@ {mentionsN > 99 ? "99+" : mentionsN}</span>
                    : unread > 0 ? <span className="ago-unread-badge">{unread > 99 ? "99+" : unread}</span> : null}
                  <span className="ago-inbox-actions">
                    <button className="ago-x show"
                      title={c.hidden ? `Show #${c.name} in your sidebar` : `Hide #${c.name} from your sidebar`}
                      onClick={e => {
                        e.stopPropagation();
                        updateChannel.mutate({ groupId: g.id, channelId: c.id, hidden: !c.hidden }, {
                          onSuccess: () => toast(c.hidden
                            ? `#${c.name} is back in your sidebar`
                            : `#${c.name} hidden for you — find it under Hidden below the groups`),
                        });
                      }}>
                      <Icon name={c.hidden ? "eye" : "eye-off"} />
                    </button>
                  </span>
                </div>
              </div>
              {c.topic ? <div className="ago-gp-topic">{c.topic}</div> : null}
            </div>
          );
        }) : (
          <div className="empty">
            <div className="glyph"><Icon name="layout-grid" /></div>
            <div>No channels yet</div>
            <div className="hint">Add a channel from the sidebar to start chatting in {g.name}.</div>
          </div>
        )}
      </div>
    </div>
  );
}
