//! Scheduled messages, hub side: the firing tick, the side effects of a fired
//! post, per-turn agent grants, and the `schedule_request` agent frame.
//!
//! Authority model: agents hold no scheduler rights of their own. Each time
//! the hub delivers a *person's* message (or a scheduled post) to an agent it
//! mints a short-lived grant for that person; a `schedule_request` must
//! present it and can only touch schedules that person owns — never an admin
//! override, even when the person is an instance admin. A grant minted for a
//! scheduled post is narrower still: it can only re-arm or cancel that one
//! schedule. Agent-authored messages never mint grants.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{json, Value};

use super::{AgentHandle, Hub};
use crate::schedule_spec::Spec;
use crate::store::{now, Fire, ScheduleChange, Store};

/// Fires handled per tick. A backlog after downtime (every overdue schedule
/// fires once) drains over successive 15 s ticks instead of posting and
/// fanning out hundreds of messages in a single blocking pass.
pub(crate) const MAX_FIRES_PER_TICK: usize = 50;
/// How long an agent may act on a delivered message's behalf. Long enough
/// for a slow multi-step turn, short enough that a leaked id goes stale.
pub(crate) const GRANT_TTL_SECS: f64 = 2.0 * 3600.0;
/// Upper bound on live grants between tick sweeps (one per person message
/// per addressed agent); beyond it the oldest are evicted in a batch.
pub(crate) const MAX_GRANTS: usize = 20_000;
/// Side effects of fires committed this recently are replayed on boot; older
/// ones would surprise agents with stale work.
pub(crate) const REDELIVER_WINDOW_SECS: f64 = 6.0 * 3600.0;
/// Delivered fire records are only kept for idempotency/debugging.
const FIRE_RETENTION_SECS: f64 = 7.0 * 86_400.0;
/// How often the running tick prunes fire records (boot does it too).
const FIRE_MAINTENANCE_EVERY_SECS: f64 = 3600.0;
/// Wait after boot before the first scheduler pass, so bridges and dial-out
/// connections have reattached: fan-out skips agents with no live socket.
pub const SCHEDULER_START_GRACE_SECS: u64 = 45;

/// The boot grace, from `AGORA_SCHEDULER_GRACE_SECS` when set to a sane value.
pub fn scheduler_start_grace(raw: Option<&str>) -> std::time::Duration {
    let secs = raw
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|s| *s <= 600)
        .unwrap_or(SCHEDULER_START_GRACE_SECS);
    std::time::Duration::from_secs(secs)
}

#[derive(Clone, Debug)]
pub(crate) struct TurnGrant {
    pub agent_id: String,
    /// The connection label the agent authenticated with ("pairing:<id>",
    /// a dial-out connection name). A grant only works from the same
    /// credential, so it survives a reconnect but not a different token.
    pub source: String,
    pub owner: String,
    pub channel_id: String,
    pub thread_id: Option<i64>,
    /// Set for grants minted from a scheduled post: only this schedule.
    pub schedule_id: Option<String>,
    pub expires_at: f64,
    /// schedule_requests served on this grant so far (capped per turn).
    pub ops: u32,
}

/// Server-side ceiling on schedule_requests per turn. Bridges cap themselves
/// lower; this stops a modified or misbehaving client from spinning on one
/// grant (each cron write costs a month-long scan).
pub(crate) const MAX_OPS_PER_GRANT: u32 = 10;

fn thread_title(store: &Store, thread_id: Option<i64>) -> Value {
    let Some(root) = thread_id.and_then(|tid| store.message(tid)) else { return Value::Null };
    if let Some(alias) = root["alias"].as_str().filter(|a| !a.is_empty()) {
        return json!(alias);
    }
    let text: String = root["text"].as_str().unwrap_or_default().chars().take(80).collect();
    json!(text)
}

/// The due time resuming a paused schedule would land on (see
/// [`reactivated_run_at`]): a slot that passed while paused is skipped, and
/// one we pick ourselves also clears the floor after the last post instead
/// of refusing the resume. Shared by `plan_change` and the "If resumed"
/// preview so the two always agree.
pub(crate) fn resume_run_at(spec: &Spec, current: &Value, now_s: f64) -> Result<f64, String> {
    let run_at = current["run_at"].as_f64().unwrap_or(0.0);
    let mut next = reactivated_run_at(spec, run_at, now_s)?;
    if let Some(floor) = posting_floor(current) {
        if next < floor && next != run_at {
            next = spec.next_after_fire(run_at, floor).unwrap_or(next);
        }
    }
    Ok(next)
}

/// Decorates schedule rows for clients: names, a preview of the next due
/// times, and (for a viewing person) whether they may manage it and still
/// see its channel. Lookups are cached per request, so a list of hundreds of
/// schedules costs one query per distinct channel / owner / thread, not
/// several per row on the shared store lock.
pub(crate) struct ScheduleDecorator<'a> {
    store: &'a Store,
    viewer: Option<(&'a str, bool)>,
    now_s: f64,
    channels: RefCell<HashMap<String, Option<Value>>>,
    owners: RefCell<HashMap<String, Value>>,
    threads: RefCell<HashMap<i64, Value>>,
    admin_of: RefCell<HashMap<String, bool>>,
    access: RefCell<HashMap<String, bool>>,
}

impl<'a> ScheduleDecorator<'a> {
    pub(crate) fn new(store: &'a Store, viewer: Option<(&'a str, bool)>, now_s: f64) -> Self {
        Self {
            store,
            viewer,
            now_s,
            channels: RefCell::default(),
            owners: RefCell::default(),
            threads: RefCell::default(),
            admin_of: RefCell::default(),
            access: RefCell::default(),
        }
    }

    fn channel(&self, id: &str) -> Option<Value> {
        self.channels
            .borrow_mut()
            .entry(id.to_string())
            .or_insert_with(|| self.store.channel(id))
            .clone()
    }

    fn owner_name(&self, owner: &str) -> Value {
        self.owners
            .borrow_mut()
            .entry(owner.to_string())
            .or_insert_with(|| {
                self.store
                    .user(owner)
                    .and_then(|u| u["display_name"].as_str().filter(|d| !d.is_empty()).map(|d| json!(d)))
                    .unwrap_or_else(|| json!(owner))
            })
            .clone()
    }

    fn thread_title(&self, thread_id: Option<i64>) -> Value {
        let Some(tid) = thread_id else { return Value::Null };
        self.threads.borrow_mut().entry(tid).or_insert_with(|| thread_title(self.store, Some(tid))).clone()
    }

    fn is_channel_admin(&self, username: &str, channel_id: &str) -> bool {
        *self
            .admin_of
            .borrow_mut()
            .entry(channel_id.to_string())
            .or_insert_with(|| self.store.user_is_channel_admin(username, channel_id))
    }

    /// Whether the viewer can still open the channel (same rule as
    /// `require_channel_member`): DMs only their owner, else admins or anyone
    /// who can see it. An owner removed from a channel still sees their own
    /// schedules there, flagged, so they can cancel them.
    fn has_access(&self, username: &str, instance_admin: bool, channel_id: &str, is_dm: bool) -> bool {
        *self.access.borrow_mut().entry(channel_id.to_string()).or_insert_with(|| {
            if is_dm {
                self.store.user_owns_agent_dm(username, channel_id)
            } else {
                instance_admin || self.store.user_can_see_channel(username, channel_id)
            }
        })
    }

    pub(crate) fn decorate(&self, item: &Value) -> Value {
        let mut out = item.clone();
        let channel_id = item["channel_id"].as_str().unwrap_or_default();
        let channel = self.channel(channel_id);
        out["channel_name"] = channel.as_ref().map(|c| c["name"].clone()).unwrap_or(Value::Null);
        out["channel_kind"] = channel.as_ref().map(|c| c["kind"].clone()).unwrap_or(Value::Null);
        out["group_id"] = channel.as_ref().map(|c| c["group_id"].clone()).unwrap_or(Value::Null);
        out["thread_title"] = self.thread_title(item["thread_id"].as_i64());
        let owner = item["owner"].as_str().unwrap_or_default();
        out["owner_name"] = self.owner_name(owner);
        // Active: the coming due times. Paused: what resuming would schedule
        // (a slot that passed while paused is skipped), never stale times.
        out["next_runs"] = match (item["status"].as_str(), Spec::from_stored(&item["schedule"]), item["run_at"].as_f64()) {
            (Some("active"), Ok(spec), Some(run_at)) => json!(spec.next_runs(run_at, 3)),
            (Some("paused"), Ok(spec), Some(_)) => match resume_run_at(&spec, item, self.now_s) {
                Ok(t) => json!(spec.next_runs(t, 3)),
                Err(_) => json!([]),
            },
            _ => json!([]),
        };
        if let Some((username, instance_admin)) = self.viewer {
            let is_dm = channel.as_ref().is_some_and(|c| c["kind"] == "agent_dm");
            // Admins may pause, cancel and retime someone else's schedule, but
            // only its owner may change how often it posts in their name.
            out["is_owner"] = json!(owner == username);
            out["can_manage"] = json!(
                owner == username
                    || (!is_dm && (instance_admin || self.is_channel_admin(username, channel_id)))
            );
            out["channel_access"] = json!(self.has_access(username, instance_admin, channel_id, is_dm));
        }
        out
    }
}

/// Decorate one row (see [`ScheduleDecorator`]); lists should share one
/// decorator so lookups are cached across rows.
pub(crate) fn decorate_schedule(store: &Store, item: &Value, viewer: Option<(&str, bool)>) -> Value {
    ScheduleDecorator::new(store, viewer, now()).decorate(item)
}

/// The thread root a schedule targets, normalised like a live post: a reply
/// id continues its thread.
fn resolve_thread_root(store: &Store, channel_id: &str, thread_id: Option<i64>) -> Result<Option<i64>, String> {
    let Some(tid) = thread_id else { return Ok(None) };
    let root = store
        .message(tid)
        .filter(|m| m["channel_id"] == channel_id)
        .ok_or("unknown thread in that channel")?;
    Ok(Some(root["thread_id"].as_i64().unwrap_or(tid)))
}

fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("text is required".into());
    }
    if text.chars().count() > crate::server::MAX_MESSAGE_CHARS {
        return Err(format!("text exceeds {} characters", crate::server::MAX_MESSAGE_CHARS));
    }
    Ok(())
}

/// The due time for a schedule becoming active again (resume, or a re-armed
/// one-off). A time that passed while it was paused must not fire a stale
/// post the moment it resumes: recurring ones skip ahead to their next slot
/// (interval keeps its phase, no burst); a one-off needs a new time.
pub(crate) fn reactivated_run_at(spec: &Spec, run_at: f64, now_s: f64) -> Result<f64, String> {
    if run_at > now_s {
        return Ok(run_at);
    }
    match spec {
        Spec::Once { .. } => Err("give a new time: this one-off's time has already passed".into()),
        _ => spec
            .next_after_fire(run_at, now_s)
            .ok_or_else(|| "that schedule has no future run".into()),
    }
}

/// Whether changing only an interval's length should keep the current due
/// time: retuning "every 1h" to "every 2h" shouldn't restart the clock from
/// the moment someone saved the editor.
/// The current due time is kept only while it is no further out than one new
/// interval: shortening "every 7 days" to "every 5 minutes" must not wait
/// out the old week before the new cadence starts.
pub(crate) fn keeps_interval_phase(current: &Value, new_spec: &Spec, now_s: f64) -> bool {
    let Spec::Interval { seconds } = new_spec else { return false };
    matches!(Spec::from_stored(&current["schedule"]), Ok(Spec::Interval { .. }))
        && current["run_at"].as_f64().is_some_and(|t| t > now_s && t <= now_s + *seconds as f64)
}

/// Slack between a slot falling due and the tick that posts it; a fire this
/// late still counts from its slot.
const FIRE_LATENESS_SLACK_SECS: f64 = 60.0;

/// The earliest next due time the posting floor allows. It counts from the
/// last post's due slot, so a fire that ran a tick late doesn't push the
/// schedule's own next slot out of reach — but never from more than a minute
/// before the post actually went out, so a catch-up fire after downtime (due
/// hours earlier) can't be re-armed to post again straight away.
pub(crate) fn posting_floor(current: &Value) -> Option<f64> {
    let last = current["last_run_at"].as_f64()?;
    let base = current["last_due_at"]
        .as_f64()
        .map_or(last, |due| due.max(last - FIRE_LATENESS_SLACK_SECS));
    Some(base + crate::schedule_spec::MIN_INTERVAL_SECS as f64)
}

/// An explicit next time must leave the posting floor after the last post:
/// otherwise a run could re-arm itself seconds ahead after every fire (or an
/// admin could keep nudging it) and post in the owner's name every tick,
/// sidestepping the interval and cron minimums.
pub(crate) fn require_floor_after_last_run(current: &Value, run_at: f64) -> Result<(), String> {
    let Some(floor) = posting_floor(current) else { return Ok(()) };
    if run_at < floor {
        return Err(format!(
            "the next run must be at least {} minutes after the last post (no earlier than {})",
            crate::schedule_spec::MIN_INTERVAL_SECS / 60,
            crate::schedule_spec::fmt_utc(floor)
        ));
    }
    Ok(())
}

/// Tick cadence of the scheduler loop.
pub const SCHEDULER_TICK_SECS: u64 = 15;

/// Whether the loop just woke from a stall (desktop sleep, a suspended
/// process): a wall-clock gap well past the tick interval means bridges are
/// probably still reconnecting, so the reconnect grace applies again before
/// firing — the same reason the boot pass waits.
pub fn tick_needs_wake_grace(prev_tick_wall: Option<f64>, now_wall: f64) -> bool {
    prev_tick_wall.is_some_and(|prev| now_wall - prev > 3.0 * SCHEDULER_TICK_SECS as f64)
}

/// When the previous tick *finished*. Measuring from its start would make a
/// slow tick (a backlog of fires after downtime) look like a sleep and add a
/// needless reconnect grace before the next one.
#[derive(Default, Debug)]
pub struct WakeClock {
    prev_end: Option<f64>,
}

impl WakeClock {
    pub fn needs_grace(&self, now_wall: f64) -> bool {
        tick_needs_wake_grace(self.prev_end, now_wall)
    }

    pub fn tick_finished(&mut self, now_wall: f64) {
        self.prev_end = Some(now_wall);
    }
}


/// Why a planned change was refused, so REST can pick a status code and the
/// agent path can pass the message on.
#[derive(Debug)]
pub(crate) enum PlanError {
    /// The request itself is malformed or out of range.
    Bad(String),
    /// Valid, but the schedule's current state forbids it.
    Conflict(String),
}

impl PlanError {
    pub(crate) fn message(self) -> String {
        match self {
            PlanError::Bad(m) | PlanError::Conflict(m) => m,
        }
    }
}

/// What a person (REST) or an agent acting for the owner asked to change.
#[derive(Default)]
pub(crate) struct ChangeRequest<'a> {
    pub text: Option<&'a str>,
    pub schedule: Option<&'a Value>,
    pub run_at: Option<&'a Value>,
    /// `"paused"` or `"active"`; anything else is refused.
    pub status: Option<&'a str>,
    /// A manager who is not the owner (channel or instance admin, REST only).
    /// They may move a pending post or pause/resume it, but never bring a
    /// finished schedule back: that would post in the owner's name on demand.
    pub non_owner: bool,
    /// Someone who doesn't decide the cadence (a non-owner manager, or a
    /// scheduled run re-arming itself): on a recurring schedule they may only
    /// push the next post later, never pull it ahead of the rule's own slot —
    /// otherwise retiming right after every fire would set the frequency.
    pub postpone_only: bool,
}

/// The one place retime / re-arm / pause / resume rules live, shared by
/// `PATCH /api/schedules/{id}` and the agent `update`/`pause`/`resume` ops so
/// the two can't drift: time validation, keeping an interval's phase,
/// bringing a finished or paused schedule back (cap + owner re-check, no
/// stale post on resume) and keeping a one-off's spec in step.
pub(crate) fn plan_change(
    store: &Store,
    current: &Value,
    req: &ChangeRequest,
    now_s: f64,
) -> Result<ScheduleChange, PlanError> {
    use PlanError::{Bad, Conflict};
    if current["status"] == "cancelled" {
        return Err(Conflict("that schedule is cancelled".into()));
    }
    let mut change = ScheduleChange::default();
    if let Some(text) = req.text.map(str::trim) {
        validate_text(text).map_err(Bad)?;
        change.text = Some(text.to_string());
    }
    // Re-sending the stored rule (an editor saved without touching the
    // cadence) is no change at all: it must not re-validate or restart the
    // clock and undo a postponed next run.
    let unchanged = |v: &Value| match (Spec::from_stored(v), Spec::from_stored(&current["schedule"])) {
        (Ok(a), Ok(b)) => a.to_json() == b.to_json(),
        _ => false,
    };
    let new_spec = match req.schedule.filter(|v| !v.is_null() && !unchanged(v)) {
        Some(v) => {
            let spec = Spec::parse(v).map_err(Bad)?;
            spec.validate_future(now_s).map_err(Bad)?;
            change.schedule = Some(spec.to_json());
            Some(spec)
        }
        None => None,
    };
    let explicit = req.run_at.filter(|v| !v.is_null());
    // Set when an explicit time is just the pending one again: no effective
    // change, so none of the move rules (floor, postpone-only) apply.
    let mut kept_pending = false;
    if let Some(v) = explicit {
        let spec = match &new_spec {
            Some(s) => s.clone(),
            None => Spec::from_stored(&current["schedule"]).map_err(Bad)?,
        };
        let mut t = resolve_run_at(&spec, Some(v), now_s).map_err(Bad)?;
        // Editors work to the minute, so a time that is the pending one to
        // within a minute means "keep it": snap to it rather than treating
        // the dropped seconds as moving the post earlier. Only a pending time
        // still ahead counts: snapping onto a past one would undo the
        // in-the-future check and drop the time the person just chose.
        if let Some(pending) = current["run_at"].as_f64().filter(|p| *p > now_s && (t - *p).abs() < 60.0) {
            t = pending;
            kept_pending = new_spec.is_none();
        }
        if kept_pending {
            // Re-confirming the pending time (an editor saved unchanged) is
            // not a move: it must not be refused by the floor after a late
            // fire, nor by postpone-only.
        } else if req.postpone_only && !matches!(spec, Spec::Once { .. }) {
            let own_slot = reactivated_run_at(&spec, current["run_at"].as_f64().unwrap_or(0.0), now_s)
                .map_err(Bad)?;
            if t + 1.0 < own_slot {
                return Err(Bad(format!(
                    "only the owner can move a repeating schedule earlier; its next run is {}",
                    crate::schedule_spec::fmt_utc(own_slot)
                )));
            }
        }
        // A non-owner manager can push someone's one-off later but never pull
        // it forward: that would make the owner "say" it on demand.
        if !kept_pending && req.non_owner && matches!(spec, Spec::Once { .. }) {
            if let Some(pending) = current["run_at"].as_f64().filter(|p| t + 1.0 < *p) {
                return Err(Bad(format!(
                    "only the owner can move this message earlier; it is due {}",
                    crate::schedule_spec::fmt_utc(pending)
                )));
            }
        }
        if !kept_pending {
            change.run_at = Some(t);
        }
    } else if let Some(spec) = &new_spec {
        if !keeps_interval_phase(current, spec, now_s) {
            let mut first = spec.first_run(now_s).ok_or_else(|| Bad("that schedule has no future run".into()))?;
            // A recurring rule's first slot we picked ourselves skips past the
            // floor after the last post rather than refusing a valid cadence
            // (the last post can land a tick after its due time). A one-off's
            // `at` is the person's own time, so it is checked, not moved.
            if !matches!(spec, Spec::Once { .. }) {
                if let Some(floor) = posting_floor(current).filter(|f| first < *f) {
                    first = spec.next_after_fire(first, floor).unwrap_or(first);
                }
            }
            change.run_at = Some(first);
        }
    }
    let status = current["status"].as_str().unwrap_or_default();
    if req.non_owner && status == "done" && (change.run_at.is_some() || req.status == Some("active")) {
        return Err(Conflict("only the owner can bring back a finished schedule".into()));
    }
    match req.status {
        None => {
            // Retiming a finished one-off brings it back (the loop re-arm).
            if change.run_at.is_some() && status == "done" {
                change.status = Some("active".into());
                change.clear_error = true;
            }
        }
        // Pausing something already paused is a no-op too (double-clicked
        // Pause, two devices), not an error toast.
        Some("paused") if status == "paused" => {}
        Some("paused") => {
            if status != "active" {
                return Err(Conflict("only an active schedule can be paused".into()));
            }
            change.status = Some("paused".into());
        }
        // Resuming something already active is a no-op: it must not skip an
        // overdue slot the next tick is about to post (a double-clicked
        // Resume, a stale client).
        Some("active") if status == "active" => {}
        Some("active") => {
            if status == "done" && change.run_at.is_none() {
                return Err(Conflict("give a new time to restart a finished schedule".into()));
            }
            // A slot that passed while paused must not fire a stale post.
            if change.run_at.is_none() {
                let spec = match &new_spec {
                    Some(s) => s.clone(),
                    None => Spec::from_stored(&current["schedule"]).map_err(Bad)?,
                };
                let run_at = current["run_at"].as_f64().unwrap_or(0.0);
                let next = resume_run_at(&spec, current, now_s).map_err(Conflict)?;
                if next != run_at {
                    change.run_at = Some(next);
                }
            }
            if status != "active" {
                change.status = Some("active".into());
            }
            change.clear_error = true;
        }
        Some(_) => return Err(Bad("status must be \"paused\" or \"active\"".into())),
    }
    if change.is_empty() {
        if kept_pending || (req.status == Some(status) && matches!(status, "active" | "paused")) {
            return Ok(change); // resume of an active / pause of a paused schedule
        }
        return Err(Bad("nothing to change (text, schedule, run_at or status)".into()));
    }
    // The floor after the last post holds for the due time this change lands
    // on, however it was set: an explicit run_at, a one-off's `at`, or a new
    // spec's first run. Otherwise `{schedule: {once, at: now+6}}` right after
    // a post would re-fire it every tick.
    if let Some(t) = change.run_at {
        require_floor_after_last_run(current, t).map_err(Bad)?;
    }
    // Anything that leads to a future post as the owner (a new time, new
    // text, coming back to life) needs the owner to still be able to post
    // there; pausing and cancelling never do.
    let revives = change.status.as_deref() == Some("active") && status != "active";
    if revives || change.run_at.is_some() || change.text.is_some() {
        let owner = current["owner"].as_str().unwrap_or_default();
        store
            .schedule_owner_can_post(owner, current["channel_id"].as_str().unwrap_or_default())
            .map_err(Conflict)?;
    }
    // The live cap for a schedule coming back to life is enforced by
    // update_schedule_if, in the same transaction as the write.
    sync_once_spec(current, &mut change);
    Ok(change)
}

/// Cancelling, shared by the agent op and `DELETE`: only something that can
/// still post (active or paused) can be cancelled. Re-cancelling, or
/// "cancelling" a finished one-off, would report a success that did nothing
/// and rewrite who last touched it.
pub(crate) fn cancel_change(current: &Value) -> Result<ScheduleChange, String> {
    match current["status"].as_str() {
        Some("active" | "paused") => {
            Ok(ScheduleChange { status: Some("cancelled".into()), ..Default::default() })
        }
        Some("cancelled") => Err("that schedule is already cancelled".into()),
        _ => Err("that schedule has already finished".into()),
    }
}

/// `run_at` override for a spec: an explicit time wins (must be sane),
/// otherwise the spec's first due time from now.
fn resolve_run_at(spec: &Spec, explicit: Option<&Value>, now_s: f64) -> Result<f64, String> {
    match explicit.filter(|v| !v.is_null()) {
        Some(v) => {
            let t = v.as_f64().filter(|t| t.is_finite() && *t > 0.0).ok_or("run_at must be unix seconds")?;
            if t > now_s + crate::schedule_spec::MAX_LEAD_SECS {
                return Err("run_at is more than 400 days ahead — is it in milliseconds?".into());
            }
            crate::schedule_spec::require_future(t, now_s)?;
            Ok(t)
        }
        None => {
            spec.validate_future(now_s)?;
            spec.first_run(now_s).ok_or_else(|| "schedule has no future run".into())
        }
    }
}

/// A one-off's spec names its time; when the due time moves (re-arm,
/// retime) keep the two in step so every client describes the real time.
pub(crate) fn sync_once_spec(current: &Value, change: &mut ScheduleChange) {
    let Some(run_at) = change.run_at else { return };
    let effective = change.schedule.clone().unwrap_or_else(|| current["schedule"].clone());
    if effective["kind"] == "once" {
        change.schedule = Some(json!({"kind": "once", "at": run_at}));
    }
}

/// The agent is still allowed in the conversation its grant came from;
/// a grant must not outlive the agent's removal from the channel.
fn agent_still_in(store: &Store, agent_id: &str, channel_id: &str) -> bool {
    store.agent_in_channel(agent_id, channel_id) && store.agent_dm_route_allowed(channel_id, agent_id)
}

/// Make room in a full grant map: drop expired grants, then the oldest tenth.
fn evict_grants(grants: &mut std::collections::HashMap<String, TurnGrant>, now_s: f64) {
    grants.retain(|_, g| g.expires_at > now_s);
    let target = MAX_GRANTS - MAX_GRANTS / 10;
    if grants.len() <= target {
        return;
    }
    let mut by_age: Vec<(f64, String)> = grants.iter().map(|(k, g)| (g.expires_at, k.clone())).collect();
    let drop_n = grants.len() - target;
    by_age.select_nth_unstable_by(drop_n - 1, |a, b| a.0.total_cmp(&b.0));
    for (_, key) in by_age.into_iter().take(drop_n) {
        grants.remove(&key);
    }
}

impl Hub {
    // ------------------------------------------------------------- grants

    /// Mint a grant when a person-authored message (or a scheduled post) is
    /// delivered to an agent. Agent-authored messages get none: an agent can
    /// never borrow authority from another agent.
    pub(super) fn mint_turn_grant(
        &self,
        handle: &AgentHandle,
        message: &Value,
        thread_id: Option<i64>,
    ) -> Option<String> {
        if message["author_type"] != "user" {
            return None;
        }
        // Only bridges that announced the capability get grants.
        if !handle.schedules {
            return None;
        }
        let owner = message["author_id"].as_str()?.to_string();
        let scheduled = message["meta"]["scheduled"] == true;
        let schedule_id = scheduled
            .then(|| message["meta"]["schedule_id"].as_str().map(str::to_string))
            .flatten();
        // A scheduled post an agent wrote empowers only that agent (to re-arm
        // or cancel it). Any other agent it mentions is hearing the writing
        // agent's request, not the person's, so it gets no authority at all.
        if scheduled {
            if let Some(writer) = message["meta"]["written_by_agent"].as_str() {
                if writer != handle.agent_id {
                    return None;
                }
            }
        }
        let turn_id = crate::store::new_token();
        let now_s = now();
        let mut st = self.state.lock().unwrap();
        // Expired grants are swept by the scheduler tick, not here: a full
        // scan on every delivery would sit on the fan-out hot path. At the
        // cap one pass drops the expired and then the oldest tenth, so the
        // next ~2k mints don't scan again (amortised O(1) per mint).
        if st.grants.len() >= MAX_GRANTS {
            evict_grants(&mut st.grants, now_s);
        }
        st.grants.insert(
            turn_id.clone(),
            TurnGrant {
                agent_id: handle.agent_id.clone(),
                source: handle.source.clone(),
                owner,
                channel_id: message["channel_id"].as_str().unwrap_or_default().to_string(),
                thread_id,
                schedule_id,
                expires_at: now_s + GRANT_TTL_SECS,
                ops: 0,
            },
        );
        Some(turn_id)
    }

    /// Drop expired grants; run from the scheduler tick.
    pub fn prune_turn_grants(&self, now_s: f64) -> usize {
        let mut st = self.state.lock().unwrap();
        let before = st.grants.len();
        st.grants.retain(|_, g| g.expires_at > now_s);
        before - st.grants.len()
    }

    #[cfg(test)]
    pub(crate) fn grant_count(&self) -> usize {
        self.state.lock().unwrap().grants.len()
    }

    /// The live grant `turn_id` names, if it belongs to this agent on this
    /// credential. Identity claimed inside the frame is never trusted.
    fn check_grant(&self, handle: &AgentHandle, turn_id: &str) -> Result<TurnGrant, String> {
        let mut st = self.state.lock().unwrap();
        let slot = st.grants.get_mut(turn_id).ok_or("unknown or expired turn_id")?;
        if slot.expires_at <= now() {
            return Err("unknown or expired turn_id".into());
        }
        if slot.agent_id != handle.agent_id || slot.source != handle.source {
            return Err("turn_id was not issued to this agent".into());
        }
        if slot.ops >= MAX_OPS_PER_GRANT {
            return Err("too many schedule requests in this turn".into());
        }
        slot.ops += 1;
        let grant = slot.clone();
        drop(st);
        // The person must still exist and be enabled: a disabled account's
        // grant must not keep reading or changing their schedules for its
        // remaining lifetime.
        let owner_ok = self
            .store
            .user(&grant.owner)
            .is_some_and(|u| !u["disabled"].as_bool().unwrap_or(false));
        if !owner_ok {
            return Err("the person this turn acts for is no longer active".into());
        }
        Ok(grant)
    }

    #[cfg(test)]
    pub(crate) fn expire_grant_for_test(&self, turn_id: &str) {
        if let Some(g) = self.state.lock().unwrap().grants.get_mut(turn_id) {
            g.expires_at = now() - 1.0;
        }
    }

    // ------------------------------------------------------------- events

    /// Tell every viewer of the channel its schedule list changed (clients
    /// refetch; the payload carries no schedule content), and the schedule's
    /// owner too. The owner's inbox lists their own schedules even where they
    /// lost access (or the channel is gone), so a tick pausing one there, or
    /// their own pause/cancel from another device, must still reach them.
    pub fn publish_schedules_changed(&self, channel_id: &str, thread_id: Option<i64>, owner: Option<&str>) {
        let event = json!({"type": "schedules_changed", "channel_id": channel_id, "thread_id": thread_id});
        let channel = self.store.channel(channel_id);
        if channel.is_some() {
            self.broadcast(channel_id, &event);
        }
        let Some(owner) = owner.filter(|o| !o.is_empty()) else { return };
        // Only the owner's sockets the broadcast didn't reach get it
        // directly; one already viewing the channel would refetch twice.
        // Mirrors broadcast's rule: privileged sockets see non-DM channels,
        // everyone else needs to be able to see it (a DM: its owner).
        let is_dm = channel.as_ref().is_some_and(|c| c["kind"] == "agent_dm");
        let owner_sees = channel.is_some()
            && if is_dm {
                self.store.user_owns_agent_dm(owner, channel_id)
            } else {
                self.store.user_can_see_channel(owner, channel_id)
            };
        let targets: Vec<(u64, tokio::sync::mpsc::UnboundedSender<Value>)> = {
            let st = self.state.lock().unwrap();
            st.sockets
                .iter()
                .filter(|s| s.username == owner)
                .filter(|s| !(channel.is_some() && ((!is_dm && s.privileged) || owner_sees)))
                .map(|s| (s.id, s.tx.clone()))
                .collect()
        };
        for (id, tx) in targets {
            if tx.send(event.clone()).is_err() {
                self.detach_socket(id);
            }
        }
    }

    /// Tell clients about schedules a cascade delete removed (channel, group,
    /// thread or user deletion): channel viewers if it survived, and the
    /// owner, whose inbox still lists it. Called right after delete
    /// handlers, and from the tick as a backstop.
    pub fn flush_schedule_cascades(&self) -> usize {
        let affected = self.store.take_schedule_cascades();
        for (channel_id, thread_id, owner) in &affected {
            self.publish_schedules_changed(channel_id, *thread_id, Some(owner));
        }
        affected.len()
    }

    pub(crate) fn publish_for(&self, schedule: &Value) {
        self.publish_schedules_changed(
            schedule["channel_id"].as_str().unwrap_or_default(),
            schedule["thread_id"].as_i64(),
            schedule["owner"].as_str(),
        );
    }

    // ------------------------------------------------------------- firing

    /// Live side effects of a committed scheduled post. It counts as the
    /// owner speaking (clears the agent-to-agent streak, mentions, agent
    /// delivery) but deliberately leaves the owner's read markers and thread
    /// hides alone: they didn't type it, so nothing should look read to them.
    pub(crate) fn deliver_scheduled(&self, message: &Value) {
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        {
            let mut st = self.state.lock().unwrap();
            st.bot_streak
                .remove(&(channel_id.to_string(), message["thread_id"].as_i64().unwrap_or(0)));
        }
        self.record_mentions(message);
        self.broadcast(channel_id, &json!({"type": "message", "message": message}));
        self.maybe_unfurl(message);
        self.fan_out(message, false, None, false, false, None);
    }

    /// One scheduler pass: post every due schedule whose owner may still post
    /// there; park the rest with the reason. Returns how many posted.
    pub fn fire_due_schedules(&self, now_s: f64) -> usize {
        let mut posted = 0;
        for schedule in self.store.due_schedules(now_s, MAX_FIRES_PER_TICK) {
            let id = schedule["id"].as_str().unwrap_or_default().to_string();
            let owner = schedule["owner"].as_str().unwrap_or_default().to_string();
            let channel_id = schedule["channel_id"].as_str().unwrap_or_default().to_string();
            let check = self.store.schedule_owner_can_post(&owner, &channel_id).and_then(|_| {
                resolve_thread_root(&self.store, &channel_id, schedule["thread_id"].as_i64()).map(|_| ())
            });
            if let Err(reason) = check {
                tracing::info!(schedule = id, reason, "pausing schedule whose owner can no longer post");
                if let Some(updated) = self.store.pause_schedule_with_error(&id, &reason) {
                    self.publish_for(&updated);
                }
                continue;
            }
            let due_at = schedule["run_at"].as_f64().unwrap_or(now_s);
            let author_name = self
                .store
                .user(&owner)
                .and_then(|u| u["display_name"].as_str().filter(|d| !d.is_empty()).map(str::to_string))
                .unwrap_or_else(|| owner.clone());
            let (message, updated) = match self.store.record_fire(&id, due_at, &author_name, now_s) {
                Fire::Posted(message, updated) => (message, updated),
                Fire::AlreadyFired(updated) => {
                    tracing::warn!(schedule = id, due_at, "slot already posted; advanced without posting");
                    self.publish_for(&updated);
                    continue;
                }
                Fire::NotDue => continue, // changed under us (repeated tick, edit)
            };
            if now_s - due_at > 60.0 {
                tracing::info!(schedule = id, late_secs = now_s - due_at, "scheduled post fired late");
            }
            self.deliver_scheduled(&message);
            self.store.mark_fire_delivered(&id, due_at);
            if let Some(updated) = &updated {
                self.publish_for(updated);
            }
            posted += 1;
        }
        posted
    }

    /// Boot recovery: fires committed but never delivered (the process died
    /// in between) get their side effects now — the message itself is
    /// already stored, so nothing posts twice.
    pub fn redeliver_pending_fires(&self, now_s: f64) -> usize {
        let mut n = 0;
        for (schedule_id, due_at, message_id) in self.store.undelivered_fires(now_s - REDELIVER_WINDOW_SECS) {
            if let Some(message) = self.store.message(message_id) {
                self.deliver_scheduled(&message);
                n += 1;
            }
            self.store.mark_fire_delivered(&schedule_id, due_at);
        }
        // Older interrupted fires would hand agents stale work; their messages
        // are stored and visible, only the live side effects are dropped.
        let skipped = self.store.skip_stale_undelivered_fires(now_s - REDELIVER_WINDOW_SECS);
        if skipped > 0 {
            tracing::warn!(skipped, "skipping side effects of scheduled posts interrupted too long ago");
        }
        self.store.prune_schedule_fires(now_s - FIRE_RETENTION_SECS);
        n
    }

    /// Hourly housekeeping from the running tick: drop old delivered fire
    /// records and stale undelivered ones, so the table stays small on a
    /// server that never restarts. Returns whether it ran.
    pub fn maintain_schedule_fires(&self, now_s: f64) -> bool {
        {
            let mut st = self.state.lock().unwrap();
            if now_s - st.last_fire_maintenance < FIRE_MAINTENANCE_EVERY_SECS {
                return false;
            }
            st.last_fire_maintenance = now_s;
        }
        let skipped = self.store.skip_stale_undelivered_fires(now_s - REDELIVER_WINDOW_SECS);
        if skipped > 0 {
            tracing::warn!(skipped, "skipping side effects of scheduled posts interrupted too long ago");
        }
        self.store.prune_schedule_fires(now_s - FIRE_RETENTION_SECS);
        true
    }

    // ------------------------------------------------------------- agent frame

    /// `schedule_request` → `schedule_response` on the asking connection.
    pub(super) fn handle_schedule_request(&self, agent_id: &str, frame: &Value) {
        let Some(handle) = self.agent_handle(agent_id) else { return };
        let mut response = json!({
            "type": "schedule_response",
            "request_id": frame["request_id"],
            "agent_id": agent_id,
        });
        match self.schedule_op(&handle, frame) {
            Ok(body) => {
                response["ok"] = json!(true);
                if let Value::Object(map) = body {
                    for (k, v) in map {
                        response[k] = v;
                    }
                }
            }
            Err(error) => {
                response["ok"] = json!(false);
                response["error"] = json!(error);
            }
        }
        let _ = handle.tx.send(response);
    }

    fn owned_schedule(&self, grant: &TurnGrant, id: &str) -> Result<Value, String> {
        let schedule = self.store.schedule(id).ok_or("unknown schedule")?;
        // Ownership, not visibility: an agent acting for an admin still only
        // reaches that admin's own schedules.
        if schedule["owner"].as_str() != Some(grant.owner.as_str()) {
            return Err("that schedule belongs to someone else".into());
        }
        // Channel scope: any thread in the grant's channel is in reach (a
        // loop's turn may manage the thread it lives in from the channel), but
        // a schedule in another channel or a private DM with another agent is
        // not.
        if schedule["channel_id"].as_str() != Some(grant.channel_id.as_str()) {
            return Err("that schedule is in another conversation".into());
        }
        if let Some(only) = &grant.schedule_id {
            if only != id {
                return Err("this turn may only re-arm or cancel its own schedule".into());
            }
        }
        Ok(schedule)
    }

    fn schedule_op(&self, handle: &AgentHandle, frame: &Value) -> Result<Value, String> {
        let turn_id = frame["turn_id"].as_str().ok_or("turn_id is required")?;
        let grant = self.check_grant(handle, turn_id)?;
        if !agent_still_in(&self.store, &handle.agent_id, &grant.channel_id) {
            return Err("this agent is no longer in that channel".into());
        }
        let op = frame["op"].as_str().ok_or("op is required")?;
        let scheduled_turn = grant.schedule_id.is_some();
        let decorate = |s: &Value| decorate_schedule(&self.store, s, None);
        let now_s = now();
        match op {
            "create" => {
                if scheduled_turn {
                    return Err("a scheduled run may only re-arm or cancel its own schedule".into());
                }
                // Only the conversation the person spoke in: the agent may not
                // be in (or able to see) any other channel the person can post in.
                let channel_id = grant.channel_id.clone();
                if frame["channel_id"].as_str().is_some_and(|c| c != channel_id) {
                    return Err("schedules can only be created in the channel this request came from".into());
                }
                let thread_id = match frame.get("thread_id") {
                    Some(v) if !v.is_null() => Some(v.as_i64().ok_or("thread_id must be a message id")?),
                    Some(_) => None,
                    None => grant.thread_id,
                };
                // Trimmed like a typed post, so it can't carry blank lines a
                // person writing the same text never could.
                let text = frame["text"].as_str().unwrap_or_default().trim();
                validate_text(text)?;
                // Turn away an over-limit request before the costly part: a
                // cron rule is validated over a month of matches.
                if let Some(refusal) = self.store.create_refusal(&grant.owner) {
                    return Err(refusal.message(&grant.owner));
                }
                let mut spec = Spec::parse(&frame["schedule"])?;
                let run_at = resolve_run_at(&spec, frame.get("run_at"), now_s)?;
                if let Spec::Once { at } = &mut spec {
                    *at = run_at; // an explicit run_at wins; keep the spec in step
                }
                self.store.schedule_owner_can_post(&grant.owner, &channel_id)?;
                let thread_id = resolve_thread_root(&self.store, &channel_id, thread_id)?;
                let created = self
                    .store
                    .create_schedule_capped(
                        &grant.owner, &channel_id, thread_id, text, run_at, &spec.to_json(),
                        &grant.owner, Some(&handle.agent_id),
                    )
                    .map_err(|e| e.message(&grant.owner))?;
                self.publish_for(&created);
                Ok(json!({"schedule": decorate(&created)}))
            }
            "update" => {
                let id = frame["id"].as_str().ok_or("id is required")?;
                let current = self.owned_schedule(&grant, id)?;
                let explicit_run_at = frame.get("run_at").filter(|v| !v.is_null());
                // A scheduled run re-arms with a new time and/or message; how
                // often it posts stays the owner's decision.
                if scheduled_turn && frame.get("schedule").is_some_and(|v| !v.is_null()) {
                    return Err("a scheduled run may only re-arm (new time/text) or cancel its own schedule".into());
                }
                let req = ChangeRequest {
                    text: frame["text"].as_str(),
                    schedule: frame.get("schedule"),
                    run_at: explicit_run_at,
                    status: None,
                    non_owner: false,
                    postpone_only: scheduled_turn,
                };
                if req.text.is_none() && req.schedule.is_none_or(Value::is_null) && req.run_at.is_none() {
                    return Err("nothing to update (text, schedule or run_at)".into());
                }
                // A paused schedule stays paused; a finished one-off with a
                // new time comes back (the loop re-arm).
                let change = plan_change(&self.store, &current, &req, now_s).map_err(PlanError::message)?;
                let updated = self
                    .store
                    .update_schedule_if(id, &current, &change, &grant.owner, Some(&handle.agent_id))
                    .map_err(|e| e.message(&grant.owner))?;
                self.publish_for(&updated);
                Ok(json!({"schedule": decorate(&updated)}))
            }
            "pause" | "resume" => {
                if scheduled_turn {
                    return Err("a scheduled run may only re-arm or cancel its own schedule".into());
                }
                let id = frame["id"].as_str().ok_or("id is required")?;
                let current = self.owned_schedule(&grant, id)?;
                // Resuming an active / pausing a paused schedule is a harmless
                // no-op (same as REST).
                if (op == "resume" && current["status"] == "active")
                    || (op == "pause" && current["status"] == "paused")
                {
                    return Ok(json!({"schedule": decorate(&current)}));
                }
                let (from, to) = if op == "pause" { ("active", "paused") } else { ("paused", "active") };
                if current["status"] != from {
                    return Err(format!("only a {from} schedule can be {op}d"));
                }
                let req = ChangeRequest { status: Some(to), ..Default::default() };
                let change = plan_change(&self.store, &current, &req, now_s).map_err(PlanError::message)?;
                let updated = self
                    .store
                    .update_schedule_if(id, &current, &change, &grant.owner, Some(&handle.agent_id))
                    .map_err(|e| e.message(&grant.owner))?;
                self.publish_for(&updated);
                Ok(json!({"schedule": decorate(&updated)}))
            }
            "cancel" => {
                let id = frame["id"].as_str().ok_or("id is required")?;
                let current = self.owned_schedule(&grant, id)?;
                let change = cancel_change(&current)?;
                let updated = self
                    .store
                    .update_schedule_if(id, &current, &change, &grant.owner, Some(&handle.agent_id))
                    .map_err(|e| e.message(&grant.owner))?;
                self.publish_for(&updated);
                Ok(json!({"schedule": decorate(&updated)}))
            }
            "list" => {
                if scheduled_turn {
                    return Err("a scheduled run may only re-arm or cancel its own schedule".into());
                }
                // The person's schedules in this conversation only: listing
                // their private channels and DMs would leak them to an agent
                // that can't see those.
                if frame["channel_id"].as_str().is_some_and(|c| c != grant.channel_id) {
                    return Err("schedules can only be listed for the channel this request came from".into());
                }
                let decorator = ScheduleDecorator::new(&self.store, None, now_s);
                let items: Vec<Value> = self
                    .store
                    .list_owner_schedules(&grant.owner)
                    .iter()
                    .filter(|s| s["channel_id"] == grant.channel_id.as_str())
                    .map(|s| decorator.decorate(s))
                    .collect();
                Ok(json!({"items": items}))
            }
            other => Err(format!("unknown op '{other}' (create, update, pause, resume, cancel, list)")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{add_agent, add_agent_full, hub, last_frame, setup_channel};
    use crate::store::MAX_LIVE_PER_OWNER;
    use super::*;

    fn req(agent: &str, turn: &str, op: &str, extra: Value) -> Value {
        let mut f = json!({"type": "schedule_request", "request_id": "r1", "agent_id": agent,
            "turn_id": turn, "op": op});
        if let Value::Object(map) = extra {
            for (k, v) in map {
                f[k] = v;
            }
        }
        f
    }

    fn ask(h: &Hub, rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>, frame: Value) -> Value {
        h.handle_agent_frame(&frame);
        last_frame(rx, "schedule_response").expect("schedule_response")
    }

    fn people(h: &Hub) {
        h.store.create_user("tom", "Tom", None, "member").unwrap();
        h.store.create_user("bob", "Bob", None, "member").unwrap();
    }

    #[test]
    fn a_backlog_drains_over_ticks_not_in_one_burst() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let gid = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        h.store.add_member(&gid, "user", "tom", "member", None);
        let backlog = MAX_FIRES_PER_TICK + 7;
        for i in 0..backlog {
            let at = now() - 100.0 + i as f64 * 0.01;
            h.store.create_schedule("tom", &cid, None, &format!("catch-up {i}"), at,
                &json!({"kind": "once", "at": at}), "tom", None);
        }
        assert_eq!(h.fire_due_schedules(now()), MAX_FIRES_PER_TICK);
        assert_eq!(h.fire_due_schedules(now()), 7, "the rest drain on the next tick");
        assert_eq!(h.fire_due_schedules(now()), 0);
    }

    #[test]
    fn schedule_changes_reach_admins_outside_the_channel() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        // Neither is a channel member; only the admin's socket is privileged.
        let (admin_tx, mut admin_rx) = tokio::sync::mpsc::unbounded_channel();
        let (member_tx, mut member_rx) = tokio::sync::mpsc::unbounded_channel();
        h.attach_socket("root", true, admin_tx);
        h.attach_socket("bob", false, member_tx);
        h.publish_schedules_changed(&cid, None, None);
        let got = admin_rx.try_recv().expect("admin inbox refreshes");
        assert_eq!(got["type"], "schedules_changed");
        assert!(admin_rx.try_recv().is_err(), "exactly one event");
        assert!(member_rx.try_recv().is_err(), "non-members learn nothing");
    }

    #[test]
    fn a_context_feed_copy_carries_no_turn() {
        let h = hub();
        people(&h);
        // Mention-gated, but fed every message as context.
        let mut quiet = add_agent_full(&h, "quiet", "Quiet", true, true);
        let cid = setup_channel(&h, &["quiet"]);
        h.post_user_message(&cid, "no tags here", "tom", Some("Tom"), None, vec![]);
        let fed = last_frame(&mut quiet, "inbound").expect("context copy delivered");
        assert!(fed.get("turn_id").is_none(), "{fed}");
        h.post_user_message(&cid, "@quiet now you", "tom", Some("Tom"), None, vec![]);
        let asked = last_frame(&mut quiet, "inbound").unwrap();
        assert!(asked["turn_id"].is_string(), "{asked}");
    }

    #[test]
    fn only_agents_that_announced_schedules_get_a_turn_id() {
        let h = hub();
        people(&h);
        let mut with = add_agent(&h, "claude", "Claude", false);
        let (tx, mut without) = tokio::sync::mpsc::unbounded_channel();
        h.register_agent(AgentHandle {
            agent_id: "plain".into(),
            agent_name: "Plain".into(),
            requires_mention: false,
            bot_loop_limit: None,
            wants_context_feed: false,
            schedules: false,
            has_avatar: false,
            avatar_v: 0,
            source: "test".into(),
            conn_id: h.next_conn_id(),
            tx,
        });
        let cid = setup_channel(&h, &["claude", "plain"]);
        h.post_user_message(&cid, "hi both", "tom", Some("Tom"), None, vec![]);
        assert!(last_frame(&mut with, "inbound").unwrap()["turn_id"].is_string());
        let plain = last_frame(&mut without, "inbound").unwrap();
        assert!(plain.get("turn_id").is_none(), "no grant without the hello flag: {plain}");
    }

    #[test]
    fn person_messages_mint_turns_and_agent_posts_never_do() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let mut codex = add_agent(&h, "codex", "Codex", false);
        let cid = setup_channel(&h, &["claude", "codex"]);
        h.post_user_message(&cid, "hi all", "tom", Some("Tom"), None, vec![]);
        let inbound = last_frame(&mut claude, "inbound").unwrap();
        assert_eq!(inbound["turn_id"].as_str().unwrap().len(), 32);
        last_frame(&mut codex, "inbound").unwrap();
        // An agent's post reaching another agent carries no authority.
        h.post_agent_message("claude", "Claude", &cid, "@codex please take this", None);
        let relayed = last_frame(&mut codex, "inbound").unwrap();
        assert_eq!(relayed["author"]["type"], "agent");
        assert!(relayed.get("turn_id").is_none());
    }

    #[test]
    fn agents_manage_only_the_requesters_own_schedules() {
        let h = hub();
        // Even an instance admin's turn reaches only that admin's schedules.
        h.store.create_user("tom", "Tom", None, "admin").unwrap();
        h.store.create_user("bob", "Bob", None, "member").unwrap();
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let mut codex = add_agent(&h, "codex", "Codex", false);
        let cid = setup_channel(&h, &["claude", "codex"]);
        h.post_user_message(&cid, "set up a loop", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let created = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "@claude LOOP demo", "schedule": {"kind": "cron", "expr": "0 7 * * *"}})));
        assert_eq!(created["ok"], true, "{created}");
        let schedule = &created["schedule"];
        assert_eq!(schedule["owner"], "tom");
        assert_eq!(schedule["via_agent"], "claude");
        assert_eq!(schedule["channel_id"], cid.as_str());
        assert_eq!(schedule["next_runs"].as_array().unwrap().len(), 3);
        let listed = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
        // Bad input gets a helpful error.
        let bad = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "x", "schedule": {"kind": "cron", "expr": "nope"}})));
        assert!(bad["error"].as_str().unwrap().contains("cron"), "{bad}");
        // Someone else's schedule is out of reach, admin or not.
        let bobs = h.store.create_schedule("bob", &cid, None, "bob's", now() + 60.0,
            &json!({"kind": "once", "at": now() + 60.0}), "bob", None);
        let denied = ask(&h, &mut claude, req("claude", &turn, "cancel",
            json!({"id": bobs["id"]})));
        assert!(denied["error"].as_str().unwrap().contains("someone else"));
        // Another agent can't replay this turn.
        h.handle_agent_frame(&req("codex", &turn, "list", json!({})));
        let stolen = last_frame(&mut codex, "schedule_response").unwrap();
        assert!(stolen["error"].as_str().unwrap().contains("not issued to this agent"));
        // Expired turns stop working.
        h.expire_grant_for_test(&turn);
        let expired = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        assert!(expired["error"].as_str().unwrap().contains("expired"));
    }

    #[test]
    fn a_scheduled_run_may_only_rearm_or_cancel_its_schedule() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let at = now() - 1.0;
        let s = h.store.create_schedule("tom", &cid, None, "@claude LOOP demo · run 1", at,
            &json!({"kind": "once", "at": at}), "tom", Some("claude"));
        let other = h.store.create_schedule("tom", &cid, None, "another", now() + 600.0,
            &json!({"kind": "once", "at": now() + 600.0}), "tom", None);
        assert_eq!(h.fire_due_schedules(now()), 1);
        let inbound = last_frame(&mut claude, "inbound").unwrap();
        assert_eq!(inbound["scheduled"], true);
        assert_eq!(inbound["author"]["id"], "tom");
        assert_eq!(inbound["schedule_id"], s["id"], "the run learns which schedule it may re-arm");
        let turn = inbound["turn_id"].as_str().unwrap().to_string();
        for (op, extra) in [
            ("create", json!({"text": "x", "schedule": {"kind": "interval", "seconds": 600}})),
            ("list", json!({})),
            ("pause", json!({"id": s["id"]})),
            ("update", json!({"id": other["id"], "run_at": now() + 60.0})),
        ] {
            let r = ask(&h, &mut claude, req("claude", &turn, op, extra));
            assert_eq!(r["ok"], false, "{op} should be refused: {r}");
        }
        // How often it posts stays the owner's call.
        let recadence = ask(&h, &mut claude, req("claude", &turn, "update", json!({
            "id": s["id"], "schedule": {"kind": "interval", "seconds": 600}})));
        assert_eq!(recadence["ok"], false, "{recadence}");
        assert!(recadence["error"].as_str().unwrap().contains("re-arm"));
        // Re-arm: a new time and message bring the finished one-off back.
        let next = now() + 3600.0;
        let rearmed = ask(&h, &mut claude, req("claude", &turn, "update", json!({
            "id": s["id"], "text": "@claude LOOP demo · run 2", "run_at": next})));
        assert_eq!(rearmed["ok"], true, "{rearmed}");
        assert_eq!(rearmed["schedule"]["status"], "active");
        assert_eq!(rearmed["schedule"]["run_at"], next);
        // The one-off's spec follows its new time, so clients describe it right.
        assert_eq!(rearmed["schedule"]["schedule"]["at"], next);
        let cancelled = ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": s["id"]})));
        assert_eq!(cancelled["schedule"]["status"], "cancelled");
    }

    #[test]
    fn a_scheduled_post_counts_as_the_owner_without_marking_anything_read() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let root = h.post_user_message(&cid, "thread root", "tom", Some("Tom"), None, vec![]);
        let tid = root["id"].as_i64().unwrap();
        h.post_agent_message("claude", "Claude", &cid, "reply one", Some(tid));
        h.post_agent_message("claude", "Claude", &cid, "reply two", Some(tid));
        h.store.hide_thread("tom", tid);
        assert_eq!(h.store.thread_unread_count("tom", tid), 2);
        assert!(h.state.lock().unwrap().bot_streak.contains_key(&(cid.clone(), tid)));
        let at = now() - 1.0;
        h.store.create_schedule("tom", &cid, Some(tid), "@claude LOOP demo", at,
            &json!({"kind": "once", "at": at}), "tom", None);
        let (ui, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        h.attach_socket("tom", false, ui);
        last_frame(&mut claude, "inbound");
        assert_eq!(h.fire_due_schedules(now()), 1);
        // The agent-to-agent streak resets, as for any person's post…
        assert!(!h.state.lock().unwrap().bot_streak.contains_key(&(cid.clone(), tid)));
        // …but the owner's thread stays unread and dismissed.
        assert_eq!(h.store.thread_unread_count("tom", tid), 2);
        assert!(h.store.unhide_thread("tom", tid), "thread stayed hidden");
        let mut saw_message = false;
        let mut saw_changed = false;
        while let Ok(ev) = ui_rx.try_recv() {
            saw_message |= ev["type"] == "message" && ev["message"]["meta"]["scheduled"] == true;
            saw_changed |= ev["type"] == "schedules_changed";
            assert_ne!(ev["type"], "thread_read", "no read marker pushed for the owner");
        }
        assert!(saw_message && saw_changed);
        assert_eq!(last_frame(&mut claude, "inbound").unwrap()["scheduled"], true);
    }

    #[test]
    fn an_owner_who_lost_access_has_the_schedule_paused_not_posted() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let gid = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        h.store.add_member(&gid, "user", "bob", "member", None);
        let at = now() - 1.0;
        let s = h.store.create_schedule("bob", &cid, None, "hello", at,
            &json!({"kind": "interval", "seconds": 600}), "bob", None);
        h.store.remove_member_all(&gid, "user", "bob");
        assert_eq!(h.fire_due_schedules(now()), 0);
        let after = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        assert_eq!(after["status"], "paused");
        assert!(after["last_error"].as_str().unwrap().contains("no longer a member"));
        assert!(h.store.due_schedules(now(), 100).is_empty(), "parked, not retried every tick");
    }

    #[test]
    fn create_and_list_stay_in_the_requests_channel() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let other = setup_channel(&h, &[]);
        h.store.create_schedule("tom", &other, None, "private elsewhere", now() + 600.0,
            &json!({"kind": "once", "at": now() + 600.0}), "tom", None);
        h.post_user_message(&cid, "set up a loop", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let elsewhere = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "channel_id": other, "text": "x", "schedule": {"kind": "interval", "seconds": 600}})));
        assert!(elsewhere["error"].as_str().unwrap().contains("channel this request came from"), "{elsewhere}");
        let here = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "here", "schedule": {"kind": "interval", "seconds": 600}})));
        assert_eq!(here["schedule"]["channel_id"], cid.as_str());
        // Listing never reveals the person's schedules in other channels.
        let listed = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        let items = listed["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["text"], "here");
        let peek = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel_id": other})));
        assert_eq!(peek["ok"], false);
    }

    #[test]
    fn only_the_addressed_agent_gets_a_turn() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let mut codex = add_agent(&h, "codex", "Codex", false);
        let cid = setup_channel(&h, &["claude", "codex"]);
        h.post_user_message(&cid, "@claude please schedule this", "tom", Some("Tom"), None, vec![]);
        assert!(last_frame(&mut claude, "inbound").unwrap()["turn_id"].is_string());
        let overheard = last_frame(&mut codex, "inbound").unwrap();
        assert_eq!(overheard["mentioned"], false);
        assert!(overheard.get("turn_id").is_none(), "context-only copy carries no authority");
        // Same rule for a scheduled post.
        let at = now() - 1.0;
        h.store.create_schedule("tom", &cid, None, "@claude LOOP demo", at,
            &json!({"kind": "once", "at": at}), "tom", None);
        assert_eq!(h.fire_due_schedules(now()), 1);
        assert!(last_frame(&mut claude, "inbound").unwrap()["turn_id"].is_string());
        assert!(last_frame(&mut codex, "inbound").unwrap().get("turn_id").is_none());
    }

    #[test]
    fn resume_skips_slots_that_passed_while_paused() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let past = now() - 3.5 * 600.0;
        let every = h.store.create_schedule("tom", &cid, None, "every", past,
            &json!({"kind": "interval", "seconds": 600}), "tom", None);
        let once = h.store.create_schedule("tom", &cid, None, "once", past,
            &json!({"kind": "once", "at": past}), "tom", None);
        for s in [&every, &once] {
            h.store.update_schedule(s["id"].as_str().unwrap(),
                &ScheduleChange { status: Some("paused".into()), ..Default::default() }, "tom", None);
        }
        h.post_user_message(&cid, "resume them", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "resume", json!({"id": every["id"]})));
        let run_at = r["schedule"]["run_at"].as_f64().unwrap();
        assert!(run_at > now(), "no stale fire on resume");
        // Phase kept: still a whole number of intervals from the old slot.
        let steps = (run_at - past) / 600.0;
        assert!((steps - steps.round()).abs() < 1e-6, "{steps}");
        assert_eq!(h.fire_due_schedules(now()), 0);
        let r = ask(&h, &mut claude, req("claude", &turn, "resume", json!({"id": once["id"]})));
        assert!(r["error"].as_str().unwrap().contains("new time"), "{r}");
    }

    #[test]
    fn re_arming_a_finished_schedule_respects_the_cap() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let done = h.store.create_schedule("tom", &cid, None, "done", now() + 60.0,
            &json!({"kind": "once", "at": now() + 60.0}), "tom", None);
        h.store.update_schedule(done["id"].as_str().unwrap(),
            &ScheduleChange { status: Some("done".into()), ..Default::default() }, "tom", None);
        for i in 0..MAX_LIVE_PER_OWNER {
            h.store.create_schedule("tom", &cid, None, &format!("s{i}"), now() + 600.0,
                &json!({"kind": "once", "at": now() + 600.0}), "tom", None);
        }
        h.post_user_message(&cid, "re-arm it", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": done["id"], "run_at": now() + 3600.0})));
        assert!(r["error"].as_str().unwrap().contains("live schedules"), "{r}");
    }

    #[test]
    fn retuning_an_interval_keeps_its_next_slot() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let next = now() + 1200.0;
        let s = h.store.create_schedule("tom", &cid, None, "hourly", next,
            &json!({"kind": "interval", "seconds": 3600}), "tom", None);
        h.post_user_message(&cid, "make it every 2h", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": s["id"], "schedule": {"kind": "interval", "seconds": 7200}})));
        assert_eq!(r["schedule"]["run_at"], next, "{r}");
        assert_eq!(r["schedule"]["schedule"]["seconds"], 7200);
    }

    #[test]
    fn fires_interrupted_too_long_ago_are_skipped_and_pruned() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let at = now() - 8.0 * 3600.0;
        let s = h.store.create_schedule("tom", &cid, None, "@claude old", at,
            &json!({"kind": "once", "at": at}), "tom", None);
        h.store.record_fire(s["id"].as_str().unwrap(), at, "Tom", at).posted().unwrap();
        assert_eq!(h.redeliver_pending_fires(now()), 0);
        assert!(last_frame(&mut claude, "inbound").is_none(), "stale work isn't replayed");
        assert!(h.store.undelivered_fires(0.0).is_empty(), "marked so prune can drop it");
    }

    #[test]
    fn boot_replays_side_effects_of_an_interrupted_fire_once() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let at = now() - 5.0;
        let s = h.store.create_schedule("tom", &cid, None, "@claude LOOP demo", at,
            &json!({"kind": "once", "at": at}), "tom", None);
        // The process "dies" after the commit, before any side effect.
        h.store.record_fire(s["id"].as_str().unwrap(), at, "Tom", now()).posted().unwrap();
        assert!(last_frame(&mut claude, "inbound").is_none());
        assert_eq!(h.redeliver_pending_fires(now()), 1);
        assert_eq!(last_frame(&mut claude, "inbound").unwrap()["scheduled"], true);
        assert_eq!(h.redeliver_pending_fires(now()), 0);
        assert_eq!(h.fire_due_schedules(now()), 0, "the post itself never repeats");
    }

    #[test]
    fn scheduler_grace_defaults_and_accepts_a_sane_override() {
        assert_eq!(scheduler_start_grace(None).as_secs(), SCHEDULER_START_GRACE_SECS);
        assert_eq!(scheduler_start_grace(Some("0")).as_secs(), 0);
        assert_eq!(scheduler_start_grace(Some(" 10 ")).as_secs(), 10);
        assert_eq!(scheduler_start_grace(Some("soon")).as_secs(), SCHEDULER_START_GRACE_SECS);
        assert_eq!(scheduler_start_grace(Some("99999")).as_secs(), SCHEDULER_START_GRACE_SECS);
    }

    #[test]
    fn the_running_tick_prunes_fire_records_at_most_hourly() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let at = now() - 8.0 * 3600.0;
        let s = h.store.create_schedule("tom", &cid, None, "old", at,
            &json!({"kind": "once", "at": at}), "tom", None);
        h.store.record_fire(s["id"].as_str().unwrap(), at, "Tom", at).posted().unwrap();
        let t = now();
        assert!(h.maintain_schedule_fires(t));
        assert!(h.store.undelivered_fires(0.0).is_empty(), "stale undelivered fire skipped");
        assert!(!h.maintain_schedule_fires(t + 60.0), "not again within the hour");
        assert!(h.maintain_schedule_fires(t + 3601.0));
    }

    #[test]
    fn times_set_by_agents_must_be_in_the_future() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "schedule it", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let past = now() - 3600.0;
        let r = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "x", "schedule": {"kind": "once", "at": past}})));
        assert!(r["error"].as_str().unwrap().contains("past"), "{r}");
        let r = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "x", "schedule": {"kind": "interval", "seconds": 600}, "run_at": past})));
        assert!(r["error"].as_str().unwrap().contains("past"), "{r}");
        let ok = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "x", "schedule": {"kind": "once", "at": now() + 600.0}})));
        assert_eq!(ok["ok"], true, "{ok}");
        let r = ask(&h, &mut claude, req("claude", &turn, "update", json!({
            "id": ok["schedule"]["id"], "run_at": past})));
        assert!(r["error"].as_str().unwrap().contains("past"), "{r}");
        // An explicit run_at on a one-off create becomes its spec time too.
        let when = now() + 7200.0;
        let made = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "y", "schedule": {"kind": "once", "at": now() + 600.0}, "run_at": when})));
        assert_eq!(made["schedule"]["schedule"]["at"], when);
        assert_eq!(made["schedule"]["run_at"], when);
    }

    #[test]
    fn a_turn_reaches_the_owners_schedules_only_in_its_own_channel() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let elsewhere = setup_channel(&h, &[]);
        let theirs = h.store.create_schedule("tom", &elsewhere, None, "private", now() + 600.0,
            &json!({"kind": "once", "at": now() + 600.0}), "tom", None);
        h.post_user_message(&cid, "hi", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        for (op, extra) in [
            ("update", json!({"id": theirs["id"], "text": "hijacked"})),
            ("cancel", json!({"id": theirs["id"]})),
            ("pause", json!({"id": theirs["id"]})),
        ] {
            let r = ask(&h, &mut claude, req("claude", &turn, op, extra));
            assert!(r["error"].as_str().unwrap().contains("another conversation"), "{op}: {r}");
        }
        assert_eq!(h.store.schedule(theirs["id"].as_str().unwrap()).unwrap()["text"], "private");
    }

    #[test]
    fn a_grant_stops_working_once_the_agent_leaves_the_channel() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "hi", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let gid = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        h.store.remove_member_all(&gid, "agent", "claude");
        let r = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        assert!(r["error"].as_str().unwrap().contains("no longer in that channel"), "{r}");
    }

    #[test]
    fn grants_are_swept_by_the_tick_and_capped() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "one", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        h.post_user_message(&cid, "two", "tom", Some("Tom"), None, vec![]);
        assert_eq!(h.grant_count(), 2);
        // Delivery no longer scans; the tick sweeps what expired.
        h.expire_grant_for_test(&turn);
        assert_eq!(h.grant_count(), 2);
        assert_eq!(h.prune_turn_grants(now()), 1);
        assert_eq!(h.grant_count(), 1);
        // At the cap the oldest grant makes room for the new one.
        {
            let mut st = h.state.lock().unwrap();
            for i in 0..MAX_GRANTS - 1 {
                st.grants.insert(format!("old{i}"), TurnGrant {
                    agent_id: "claude".into(), source: "test".into(), owner: "tom".into(),
                    channel_id: cid.clone(), thread_id: None, schedule_id: None,
                    expires_at: now() + 10.0 + i as f64, ops: 0,
                });
            }
        }
        h.post_user_message(&cid, "three", "tom", Some("Tom"), None, vec![]);
        let newest = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let st = h.state.lock().unwrap();
        // One batch eviction made room for many more mints, not just one.
        assert!(st.grants.len() <= MAX_GRANTS - MAX_GRANTS / 10 + 1, "{}", st.grants.len());
        assert!(st.grants.contains_key(&newest));
        assert!(!st.grants.contains_key("old0"), "oldest evicted first");
        assert!(st.grants.contains_key(&format!("old{}", MAX_GRANTS - 2)), "newest old grant kept");
    }

    #[test]
    fn rearm_and_resume_recheck_the_owner_but_pause_and_cancel_dont() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "loop please", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let at = now() + 600.0;
        let s = h.store.create_schedule("tom", &cid, None, "x", at,
            &json!({"kind": "interval", "seconds": 600}), "tom", Some("claude"));
        let id = s["id"].clone();
        assert_eq!(ask(&h, &mut claude, req("claude", &turn, "pause", json!({"id": id})))["ok"], true);
        // Tom loses the channel (but is still an active account).
        let gid = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        h.store.remove_member_all(&gid, "user", "tom");
        for (op, extra) in [
            ("resume", json!({"id": id})),
            ("update", json!({"id": id, "run_at": now() + 1200.0})),
            ("update", json!({"id": id, "text": "new text"})),
        ] {
            let r = ask(&h, &mut claude, req("claude", &turn, op, extra));
            assert!(r["error"].as_str().unwrap_or_default().contains("no longer a member"), "{op}: {r}");
        }
        let r = ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": id})));
        assert_eq!(r["ok"], true, "cancel stays allowed: {r}");
    }

    #[test]
    fn a_disabled_persons_grant_stops_working_entirely() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "loop please", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let s = h.store.create_schedule("tom", &cid, None, "x", now() + 600.0,
            &json!({"kind": "interval", "seconds": 600}), "tom", Some("claude"));
        h.store.set_user_disabled("tom", true);
        for (op, extra) in [
            ("list", json!({})),
            ("pause", json!({"id": s["id"]})),
            ("cancel", json!({"id": s["id"]})),
        ] {
            let r = ask(&h, &mut claude, req("claude", &turn, op, extra));
            assert!(r["error"].as_str().unwrap_or_default().contains("no longer active"), "{op}: {r}");
        }
        assert_eq!(h.store.schedule(s["id"].as_str().unwrap()).unwrap()["status"], "active");
    }

    #[test]
    fn a_scheduled_run_cannot_rearm_itself_seconds_after_posting() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let at = now() - 1.0;
        let s = h.store.create_schedule("tom", &cid, None, "@claude LOOP demo", at,
            &json!({"kind": "once", "at": at}), "tom", Some("claude"));
        assert_eq!(h.fire_due_schedules(now()), 1);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let soon = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": s["id"], "run_at": now() + 1.0})));
        assert_eq!(soon["ok"], false, "{soon}");
        assert!(soon["error"].as_str().unwrap().contains("at least 5 minutes"), "{soon}");
        let later = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": s["id"], "run_at": now() + 400.0})));
        assert_eq!(later["ok"], true, "{later}");
    }

    #[test]
    fn wake_grace_applies_only_after_a_stall() {
        assert!(!tick_needs_wake_grace(None, 1000.0), "first tick: the boot grace already ran");
        assert!(!tick_needs_wake_grace(Some(1000.0), 1015.0));
        assert!(!tick_needs_wake_grace(Some(1000.0), 1044.0));
        assert!(tick_needs_wake_grace(Some(1000.0), 1046.0));
        assert!(tick_needs_wake_grace(Some(1000.0), 1000.0 + 8.0 * 3600.0), "overnight sleep");
    }

    #[test]
    fn shortening_an_interval_does_not_wait_out_the_old_one() {
        let t = now();
        let current = json!({"schedule": {"kind": "interval", "seconds": 7 * 86_400}, "run_at": t + 6.0 * 86_400.0});
        assert!(!keeps_interval_phase(&current, &Spec::Interval { seconds: 300 }, t));
        assert!(keeps_interval_phase(&current, &Spec::Interval { seconds: 7 * 86_400 }, t));
        let near = json!({"schedule": {"kind": "interval", "seconds": 3600}, "run_at": t + 100.0});
        assert!(keeps_interval_phase(&near, &Spec::Interval { seconds: 300 }, t), "a near due time stays");
    }

    #[test]
    fn agent_resume_of_an_active_schedule_changes_nothing() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let due = now() - 5.0;
        let s = h.store.create_schedule("tom", &cid, None, "due", due,
            &json!({"kind": "interval", "seconds": 600}), "tom", None);
        h.post_user_message(&cid, "resume it", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "resume", json!({"id": s["id"]})));
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["schedule"]["run_at"], due);
        // Pausing twice is the same kind of no-op, not an error.
        let p1 = ask(&h, &mut claude, req("claude", &turn, "pause", json!({"id": s["id"]})));
        assert_eq!(p1["schedule"]["status"], "paused", "{p1}");
        let p2 = ask(&h, &mut claude, req("claude", &turn, "pause", json!({"id": s["id"]})));
        assert_eq!(p2["ok"], true, "{p2}");
        assert_eq!(p2["schedule"]["status"], "paused");
        assert_eq!(p2["schedule"]["updated_at"], p1["schedule"]["updated_at"], "nothing was written");
    }

    #[test]
    fn an_agent_written_post_empowers_only_its_writer() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let mut codex = add_agent(&h, "codex", "Codex", false);
        let cid = setup_channel(&h, &["claude", "codex"]);
        let at = now() - 1.0;
        let s = h.store.create_schedule("tom", &cid, None, "@claude @codex daily check", at,
            &json!({"kind": "once", "at": at}), "tom", Some("claude"));
        assert_eq!(h.fire_due_schedules(now()), 1);
        let mine = last_frame(&mut claude, "inbound").unwrap();
        assert_eq!(mine["written_by_agent"], "claude");
        assert!(mine["turn_id"].is_string(), "the writer may re-arm or cancel its post");
        assert_eq!(mine["schedule_id"], s["id"]);
        let theirs = last_frame(&mut codex, "inbound").unwrap();
        assert_eq!(theirs["scheduled"], true);
        assert_eq!(theirs["author"]["id"], "tom");
        assert_eq!(theirs["written_by_agent"], "claude");
        assert_eq!(theirs["written_by_agent_name"], "Claude");
        assert!(theirs.get("turn_id").is_none(), "another agent gets no authority from it");
    }

    #[test]
    fn a_post_no_agent_wrote_keeps_person_grants() {
        let h = hub();
        people(&h);
        let mut codex = add_agent(&h, "codex", "Codex", false);
        let cid = setup_channel(&h, &["codex"]);
        let at = now() - 1.0;
        h.store.create_schedule("tom", &cid, None, "@codex weekly report", at,
            &json!({"kind": "once", "at": at}), "tom", None);
        assert_eq!(h.fire_due_schedules(now()), 1);
        let inbound = last_frame(&mut codex, "inbound").unwrap();
        assert!(inbound.get("written_by_agent").is_none());
        assert!(inbound["turn_id"].is_string());
    }

    #[test]
    fn text_agent_tracks_the_last_agent_that_wrote_the_words() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let s = h.store.create_schedule("tom", &cid, None, "v1", now() + 600.0,
            &json!({"kind": "once", "at": now() + 600.0}), "tom", Some("claude"));
        assert_eq!(s["text_agent"], "claude");
        let id = s["id"].as_str().unwrap();
        // A retime by a person keeps who wrote the words.
        let retimed = h.store.update_schedule(id,
            &ScheduleChange { run_at: Some(now() + 900.0), ..Default::default() }, "tom", None).unwrap();
        assert_eq!(retimed["text_agent"], "claude");
        let rewritten = h.store.update_schedule(id,
            &ScheduleChange { text: Some("v2".into()), ..Default::default() }, "tom", Some("codex")).unwrap();
        assert_eq!(rewritten["text_agent"], "codex");
    }

    #[test]
    fn a_new_once_spec_cannot_land_seconds_after_the_last_post() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let at = now() - 1.0;
        let s = h.store.create_schedule("tom", &cid, None, "ping", at,
            &json!({"kind": "once", "at": at}), "tom", Some("claude"));
        assert_eq!(h.fire_due_schedules(now()), 1);
        // A person's turn (not the scheduled one) trying the spec route.
        h.post_user_message(&cid, "again please", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let soon = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": s["id"], "schedule": {"kind": "once", "at": now() + 6.0}})));
        assert_eq!(soon["ok"], false, "{soon}");
        assert!(soon["error"].as_str().unwrap().contains("at least 5 minutes"), "{soon}");
        let ok = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": s["id"], "schedule": {"kind": "once", "at": now() + 600.0}})));
        assert_eq!(ok["ok"], true, "{ok}");
    }

    #[test]
    fn agent_creates_are_rate_limited_per_owner_and_text_is_trimmed() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "set some up", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let first = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "\n\n  @claude LOOP check \n", "schedule": {"kind": "interval", "seconds": 600}})));
        assert_eq!(first["schedule"]["text"], "@claude LOOP check");
        // One turn may only make MAX_OPS_PER_GRANT requests, so the burst
        // spreads across fresh turns from the same person.
        let mut turn = turn;
        let mut used = 1;
        for i in 1..crate::store::MAX_CREATES_PER_HOUR {
            if used == MAX_OPS_PER_GRANT {
                h.post_user_message(&cid, "more", "tom", Some("Tom"), None, vec![]);
                turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
                used = 0;
            }
            let r = ask(&h, &mut claude, req("claude", &turn, "create", json!({
                "text": format!("n{i}"), "schedule": {"kind": "interval", "seconds": 600}})));
            assert_eq!(r["ok"], true, "{r}");
            used += 1;
        }
        h.post_user_message(&cid, "one more", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let burst = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "one too many", "schedule": {"kind": "once", "at": now() + 600.0}})));
        assert_eq!(burst["ok"], false);
        assert!(burst["error"].as_str().unwrap().contains("last hour"), "{burst}");
    }

    #[test]
    fn a_slow_tick_is_not_mistaken_for_a_sleep() {
        let mut clock = WakeClock::default();
        assert!(!clock.needs_grace(0.0), "first tick never waits");
        // The tick started at 0 but its work ran until 40s.
        clock.tick_finished(40.0);
        assert!(!clock.needs_grace(55.0), "15s after the slow tick ended is a normal gap");
        clock.tick_finished(55.0);
        assert!(clock.needs_grace(55.0 + 4.0 * SCHEDULER_TICK_SECS as f64), "a real stall still waits");
    }

    #[test]
    fn a_paused_schedule_previews_what_resuming_would_do() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let past = now() - 3.5 * 600.0;
        let s = h.store.create_schedule("tom", &cid, None, "every", past,
            &json!({"kind": "interval", "seconds": 600}), "tom", None);
        let id = s["id"].as_str().unwrap();
        h.store.update_schedule(id, &ScheduleChange { status: Some("paused".into()), ..Default::default() }, "tom", None);
        let paused = h.store.schedule(id).unwrap();
        let shown = decorate_schedule(&h.store, &paused, Some(("tom", false)));
        let runs = shown["next_runs"].as_array().unwrap();
        assert_eq!(runs.len(), 3);
        let first = runs[0].as_f64().unwrap();
        assert!(first > now(), "never a time that already passed");
        let spec = Spec::from_stored(&paused["schedule"]).unwrap();
        assert_eq!(first, resume_run_at(&spec, &paused, now()).unwrap());
        // A paused one-off whose time passed has nothing to preview.
        let once = h.store.create_schedule("tom", &cid, None, "once", past,
            &json!({"kind": "once", "at": past}), "tom", None);
        let oid = once["id"].as_str().unwrap();
        h.store.update_schedule(oid, &ScheduleChange { status: Some("paused".into()), ..Default::default() }, "tom", None);
        let shown = decorate_schedule(&h.store, &h.store.schedule(oid).unwrap(), Some(("tom", false)));
        assert!(shown["next_runs"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_cascade_reaches_an_owner_viewing_the_channel_only_once() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let gid = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        h.store.add_member(&gid, "user", "tom", "member", None);
        let root = h.post_user_message(&cid, "thread root", "tom", Some("Tom"), None, vec![]);
        let tid = root["id"].as_i64().unwrap();
        h.store.create_schedule("tom", &cid, Some(tid), "in thread", now() + 600.0,
            &json!({"kind": "once", "at": now() + 600.0}), "tom", None);
        let (ui, mut rx) = tokio::sync::mpsc::unbounded_channel();
        h.attach_socket("tom", false, ui);
        h.store.delete_message(tid);
        assert!(h.flush_schedule_cascades() >= 1);
        let mut n = 0;
        while let Ok(ev) = rx.try_recv() {
            n += (ev["type"] == "schedules_changed") as usize;
        }
        assert_eq!(n, 1, "the channel broadcast already reached the owner");
    }

    #[test]
    fn a_tick_pause_reaches_an_owner_who_lost_the_channel() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let gid = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        h.store.add_member(&gid, "user", "bob", "member", None);
        let at = now() - 1.0;
        h.store.create_schedule("bob", &cid, None, "hello", at,
            &json!({"kind": "interval", "seconds": 600}), "bob", None);
        h.store.remove_member_all(&gid, "user", "bob");
        let (ui, mut ui_rx) = tokio::sync::mpsc::unbounded_channel();
        h.attach_socket("bob", false, ui);
        assert_eq!(h.fire_due_schedules(now()), 0);
        let mut changes = 0;
        while let Ok(ev) = ui_rx.try_recv() {
            changes += usize::from(ev["type"] == "schedules_changed");
        }
        assert_eq!(changes, 1, "exactly one event, sent to the owner directly");
    }

    #[test]
    fn reviving_finished_one_offs_counts_toward_the_hourly_limit() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "loops", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let done = ScheduleChange { status: Some("done".into()), ..Default::default() };
        let at = now() + 3600.0;
        let mut ids = Vec::new();
        for _ in 0..crate::store::MAX_CREATES_PER_HOUR - 1 {
            let s = h.store.create_schedule("tom", &cid, None, "x", at,
                &json!({"kind": "once", "at": at}), "tom", Some("claude"));
            h.store.update_schedule(s["id"].as_str().unwrap(), &done, "tom", None);
            ids.push(s["id"].clone());
        }
        // 29 creations so far: one revival fits, the next one doesn't.
        let first = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": ids[0], "run_at": now() + 900.0})));
        assert_eq!(first["ok"], true, "{first}");
        let second = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": ids[1], "run_at": now() + 900.0})));
        assert!(second["error"].as_str().unwrap_or_default().contains("in the last hour"), "{second}");
    }

    #[test]
    fn a_new_cadence_right_after_a_late_post_skips_past_the_floor() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        // A 07:00-style post that landed 7 s late, so the floor sits just
        // past the new rule's first 5-minute slot.
        let base = (now() / 300.0).floor() * 300.0 + 600.0;
        let s = h.store.create_schedule("tom", &cid, None, "x", base + 86_400.0,
            &json!({"kind": "cron", "expr": "0 7 * * *"}), "tom", None);
        let mut current = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        current["last_run_at"] = json!(base - 300.0 + 7.0);
        let new_spec = json!({"kind": "cron", "expr": "*/5 * * * *"});
        let req = ChangeRequest { schedule: Some(&new_spec), ..Default::default() };
        let change = plan_change(&h.store, &current, &req, base - 240.0).expect("valid cadence is accepted");
        assert_eq!(change.run_at, Some(base + 300.0), "first slot moved past the floor, not refused");
    }

    #[test]
    fn only_the_owner_can_pull_a_repeating_schedule_earlier() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let now_s = now();
        let next = now_s + 3600.0;
        let s = h.store.create_schedule("tom", &cid, None, "x", next,
            &json!({"kind": "interval", "seconds": 7200}), "tom", None);
        let current = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        let earlier = json!(now_s + 600.0);
        let later = json!(next + 600.0);
        // A non-owner manager (or a scheduled run) may postpone, not pull ahead.
        let req = ChangeRequest { run_at: Some(&earlier), postpone_only: true, non_owner: true, ..Default::default() };
        let refused = plan_change(&h.store, &current, &req, now_s).err().expect("earlier refused");
        assert!(refused.message().contains("only the owner can move a repeating schedule earlier"));
        let req = ChangeRequest { run_at: Some(&later), postpone_only: true, non_owner: true, ..Default::default() };
        assert_eq!(plan_change(&h.store, &current, &req, now_s).unwrap().run_at, Some(next + 600.0));
        // The owner can still pull it in.
        let req = ChangeRequest { run_at: Some(&earlier), ..Default::default() };
        assert_eq!(plan_change(&h.store, &current, &req, now_s).unwrap().run_at, Some(now_s + 600.0));
    }

    #[test]
    fn resaving_the_stored_rule_keeps_a_postponed_next_run() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let now_s = now();
        let postponed = now_s + 5.0 * 86_400.0;
        let rule = json!({"kind": "cron", "expr": "0 7 * * *"});
        let s = h.store.create_schedule("tom", &cid, None, "x", postponed, &rule, "tom", None);
        let current = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        // The editor saved without touching the cadence: nothing to change.
        let req = ChangeRequest { schedule: Some(&rule), ..Default::default() };
        let err = plan_change(&h.store, &current, &req, now_s).err().expect("no-op").message();
        assert!(err.contains("nothing to change"), "{err}");
        // An actually different rule still applies.
        let other = json!({"kind": "cron", "expr": "30 8 * * *"});
        let req = ChangeRequest { schedule: Some(&other), ..Default::default() };
        let change = plan_change(&h.store, &current, &req, now_s).unwrap();
        assert!(change.schedule.is_some() && change.run_at.unwrap() < postponed);
    }

    #[test]
    fn a_minute_precise_retime_of_the_pending_run_keeps_it() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let now_s = now();
        let due = now_s + 3600.0 + 41.3;
        let s = h.store.create_schedule("tom", &cid, None, "x", due,
            &json!({"kind": "interval", "seconds": 3600}), "tom", None);
        let current = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        // An admin's editor shows the minute and sends it back without seconds.
        let same_minute = json!((due / 60.0).floor() * 60.0);
        let req = ChangeRequest { run_at: Some(&same_minute), postpone_only: true, non_owner: true, ..Default::default() };
        // Snapped onto the pending time: accepted, and nothing moves.
        assert_eq!(plan_change(&h.store, &current, &req, now_s).unwrap().run_at, None);
    }

    #[test]
    fn reconfirming_the_pending_time_after_a_late_fire_is_not_refused() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let now_s = now();
        // Interval 300 s, due D, fired 120 s late: next run D+300, but the
        // posting floor is D+360. Sending the pending time back is a no-op.
        let d = now_s - 120.0;
        let mut current = h.store.create_schedule("tom", &cid, None, "x", d + 300.0,
            &json!({"kind": "interval", "seconds": 300}), "tom", None);
        current["last_due_at"] = json!(d);
        current["last_run_at"] = json!(now_s);
        let same = json!(d + 300.0);
        for req in [
            ChangeRequest { run_at: Some(&same), ..Default::default() },
            ChangeRequest { run_at: Some(&same), postpone_only: true, ..Default::default() },
            ChangeRequest { run_at: Some(&same), postpone_only: true, non_owner: true, ..Default::default() },
        ] {
            let change = plan_change(&h.store, &current, &req, now_s).expect("no-op accepted");
            assert!(change.is_empty(), "nothing moves");
        }
        // A real move still has to clear the floor.
        let early = json!(d + 200.0);
        assert!(plan_change(&h.store, &current, &ChangeRequest { run_at: Some(&early), ..Default::default() }, now_s).is_err());
    }

    #[test]
    fn the_posting_floor_counts_from_the_due_slot_of_a_late_fire() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let now_s = now();
        let mut current = h.store.create_schedule("tom", &cid, None, "x", now_s + 286.0,
            &json!({"kind": "interval", "seconds": 300}), "tom", None);
        // Due 14 s ago, posted now: its own next slot is 286 s away.
        current["last_due_at"] = json!(now_s - 14.0);
        current["last_run_at"] = json!(now_s);
        assert!(require_floor_after_last_run(&current, now_s + 286.0).is_ok());
        assert!(require_floor_after_last_run(&current, now_s + 200.0).is_err());
        // A catch-up fire hours after its slot still waits 5 minutes from now.
        current["last_due_at"] = json!(now_s - 4.0 * 3600.0);
        assert!(require_floor_after_last_run(&current, now_s + 60.0).is_err());
        assert!(require_floor_after_last_run(&current, now_s + 300.0 - 60.0).is_ok());
    }

    #[test]
    fn a_non_owner_may_only_push_a_one_off_later() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let now_s = now();
        let due = now_s + 3600.0;
        let s = h.store.create_schedule("tom", &cid, None, "x", due,
            &json!({"kind": "once", "at": due}), "tom", None);
        let current = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        let earlier = json!(now_s + 60.0);
        let later = json!(due + 600.0);
        let req = ChangeRequest { run_at: Some(&earlier), postpone_only: true, non_owner: true, ..Default::default() };
        let refused = plan_change(&h.store, &current, &req, now_s).err().expect("pulling in refused").message();
        assert!(refused.contains("only the owner can move this message earlier"), "{refused}");
        let req = ChangeRequest { run_at: Some(&later), postpone_only: true, non_owner: true, ..Default::default() };
        assert_eq!(plan_change(&h.store, &current, &req, now_s).unwrap().run_at, Some(due + 600.0));
        // The owner (and an agent acting for them) can still bring it in.
        let req = ChangeRequest { run_at: Some(&earlier), ..Default::default() };
        assert_eq!(plan_change(&h.store, &current, &req, now_s).unwrap().run_at, Some(now_s + 60.0));
    }

    #[test]
    fn a_scheduled_run_may_postpone_but_not_pull_in_an_interval() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let at = now() - 1.0;
        let s = h.store.create_schedule("tom", &cid, None, "@claude LOOP demo", at,
            &json!({"kind": "interval", "seconds": 3600}), "tom", Some("claude"));
        assert_eq!(h.fire_due_schedules(now()), 1);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let pulled = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": s["id"], "run_at": now() + 600.0})));
        assert!(pulled["error"].as_str().unwrap_or_default().contains("earlier"), "{pulled}");
        let pushed = ask(&h, &mut claude, req("claude", &turn, "update",
            json!({"id": s["id"], "run_at": now() + 7200.0})));
        assert_eq!(pushed["ok"], true, "{pushed}");
    }

    #[test]
    fn an_over_limit_create_is_refused_before_the_rule_is_parsed() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "more", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let at = now() + 3600.0;
        for _ in 0..crate::store::MAX_CREATES_PER_HOUR {
            h.store.create_schedule("tom", &cid, None, "x", at,
                &json!({"kind": "once", "at": at}), "tom", None);
        }
        let r = ask(&h, &mut claude, req("claude", &turn, "create",
            json!({"text": "y", "schedule": {"kind": "cron", "expr": "not a rule"}})));
        let error = r["error"].as_str().unwrap_or_default();
        assert!(error.contains("in the last hour") && !error.contains("cron"), "{r}");
    }

    #[test]
    fn a_change_planned_from_a_stale_spec_is_refused() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let s = h.store.create_schedule("tom", &cid, None, "x", now() + 3600.0,
            &json!({"kind": "interval", "seconds": 3600}), "tom", None);
        let id = s["id"].as_str().unwrap();
        let stale = h.store.schedule(id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        // Someone retunes the cadence; status and due time stay the same.
        let retune = ScheduleChange { schedule: Some(json!({"kind": "interval", "seconds": 7200})), ..Default::default() };
        h.store.update_schedule_if(id, &stale, &retune, "tom", None).unwrap();
        let pause = ScheduleChange { status: Some("paused".into()), ..Default::default() };
        assert_eq!(
            h.store.update_schedule_if(id, &stale, &pause, "root", None).unwrap_err(),
            crate::store::UpdateRefused::Changed
        );
    }

    #[test]
    fn agents_cannot_cancel_what_is_already_finished_or_cancelled() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "tidy up", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let at = now() + 600.0;
        let s = h.store.create_schedule("tom", &cid, None, "x", at,
            &json!({"kind": "once", "at": at}), "tom", Some("claude"));
        assert_eq!(ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": s["id"]})))["ok"], true);
        let again = ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": s["id"]})));
        assert!(again["error"].as_str().unwrap_or_default().contains("already cancelled"), "{again}");
        let d = h.store.create_schedule("tom", &cid, None, "y", at,
            &json!({"kind": "once", "at": at}), "tom", Some("claude"));
        h.store.update_schedule(d["id"].as_str().unwrap(),
            &ScheduleChange { status: Some("done".into()), ..Default::default() }, "tom", None);
        let finished = ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": d["id"]})));
        assert!(finished["error"].as_str().unwrap_or_default().contains("already finished"), "{finished}");
    }

    #[test]
    fn a_new_time_is_not_snapped_onto_a_pending_time_that_has_passed() {
        let h = hub();
        people(&h);
        let cid = setup_channel(&h, &[]);
        let now_s = now();
        let past = now_s - 20.0;
        let s = h.store.create_schedule("tom", &cid, None, "x", past,
            &json!({"kind": "once", "at": past}), "tom", None);
        let current = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        let soon = json!(now_s + 30.0);
        let req = ChangeRequest { run_at: Some(&soon), ..Default::default() };
        assert_eq!(plan_change(&h.store, &current, &req, now_s).unwrap().run_at, Some(now_s + 30.0));
        // A pending time still ahead keeps absorbing minute-precision edits.
        let ahead = now_s + 600.0;
        let s = h.store.create_schedule("tom", &cid, None, "y", ahead,
            &json!({"kind": "once", "at": ahead}), "tom", None);
        let current = h.store.schedule(s["id"].as_str().unwrap()).unwrap();
        let minute = json!(ahead - 30.0);
        let req = ChangeRequest { run_at: Some(&minute), ..Default::default() };
        assert_eq!(plan_change(&h.store, &current, &req, now_s).unwrap().run_at, None, "kept as is");
    }

    #[test]
    fn one_grant_serves_a_bounded_number_of_schedule_requests() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "list my schedules", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        for _ in 0..MAX_OPS_PER_GRANT {
            let ok = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
            assert_eq!(ok["ok"], true, "{ok}");
        }
        let capped = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        assert!(capped["error"].as_str().unwrap_or_default().contains("too many schedule requests"), "{capped}");
    }
}
