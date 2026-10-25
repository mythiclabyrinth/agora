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
/// Most schedules an agent `list` reads (live-first) before paging; the
/// response says `truncated` when the owner has more.
pub(crate) const MAX_AGENT_LISTED: usize = 1000;
/// How long an agent may act on a delivered message's behalf. Long enough
/// for a slow multi-step turn, short enough that a leaked id goes stale.
/// How much of the person's message a grant keeps for finding the
/// conversations they named.
pub(crate) const UNLOCK_TEXT_MAX_CHARS: usize = 4096;
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
    /// The person's own words that started this turn, lowercased. Another
    /// conversation is in reach only when these words name it, so an agent
    /// can't act elsewhere just by supplying a channel itself. None for
    /// scheduled posts (their text may have been written by an agent).
    pub unlock_text: Option<String>,
}

/// Server-side ceiling on schedule_requests per turn. Bridges cap themselves
/// lower; this stops a modified or misbehaving client from spinning on one
/// grant (each cron write costs a month-long scan).
pub(crate) const MAX_OPS_PER_GRANT: u32 = 10;
/// Agent `list` pages: default and largest page size.
pub(crate) const LIST_PAGE_DEFAULT: usize = 20;
pub(crate) const LIST_PAGE_MAX: usize = 50;
/// Shown on a schedule whose post @mentioned an agent that wasn't connected
/// when it fired. Deliberately generic: it never names the agent(s).
pub(crate) const OFFLINE_AGENT_ERROR: &str =
    "An agent this message mentions wasn't connected when it posted, so it may not have received it.";

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

/// A new schedule that passed every check, ready to store.
#[derive(Clone, Debug)]
pub(crate) struct CheckedSchedule {
    pub channel_id: String,
    pub thread_id: Option<i64>,
    pub text: String,
    /// The validated spec (a one-off's `at` kept in step with `run_at`).
    pub schedule: Value,
    pub run_at: f64,
}

/// Every check a new schedule must pass before it is stored, shared by the
/// agent `create` op and Jarvis (at draft time and again at confirmation):
/// text, the owner's caps, the spec, its first run, posting rights, thread.
pub(crate) fn check_new_schedule(
    store: &Store,
    owner: &str,
    channel_id: &str,
    thread_id: Option<i64>,
    text: &str,
    schedule: &Value,
    run_at: Option<&Value>,
    now_s: f64,
) -> Result<CheckedSchedule, String> {
    // Trimmed like a typed post, so it can't carry blank lines a person
    // writing the same text never could.
    let text = text.trim();
    validate_text(text)?;
    // Turn away an over-limit request before the costly part: a cron rule
    // is validated over a month of matches.
    if let Some(refusal) = store.create_refusal(owner) {
        return Err(refusal.message(owner));
    }
    let mut spec = Spec::parse(schedule)?;
    let run_at = resolve_run_at(&spec, run_at, now_s)?;
    if let Spec::Once { at } = &mut spec {
        *at = run_at; // an explicit run_at wins; keep the spec in step
    }
    store.schedule_owner_can_post(owner, channel_id)?;
    let thread_id = resolve_thread_root(store, channel_id, thread_id)?;
    Ok(CheckedSchedule { channel_id: channel_id.into(), thread_id, text: text.into(), schedule: spec.to_json(), run_at })
}

impl Hub {
    /// Store a checked schedule (caps re-checked in the transaction) and tell
    /// its viewers. `via_agent` is None when the person themselves confirmed
    /// it (Jarvis): their reviewed text is theirs, not an agent's.
    pub(crate) fn create_checked_schedule(&self, owner: &str, c: &CheckedSchedule, via_agent: Option<&str>) -> Result<Value, String> {
        let created = self
            .store
            .create_schedule_capped(owner, &c.channel_id, c.thread_id, &c.text, c.run_at, &c.schedule, owner, via_agent)
            .map_err(|e| e.message(owner))?;
        self.publish_for(&created);
        Ok(created)
    }
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

/// The agent is in that conversation and the owner can still post there: the
/// reach an agent has over an owner's schedules outside the grant's channel.
fn agent_may_reach(store: &Store, agent_id: &str, owner: &str, channel_id: &str) -> bool {
    agent_still_in(store, agent_id, channel_id) && store.schedule_owner_can_post(owner, channel_id).is_ok()
}

/// Resolve a channel the person named ("exec-comp", "#exec-comp", or "dm" /
/// "direct message" / this agent's name for their DM with it) among the
/// conversations this agent is in and the owner can reach. Unknown or
/// ambiguous names fail without naming anything private.
fn resolve_named_channel(store: &Store, handle: &AgentHandle, owner: &str, raw: &str) -> Result<String, String> {
    let name = raw.trim().trim_start_matches('#').trim();
    if name.is_empty() {
        return Err("channel must be a channel name".into());
    }
    let lower = name.to_lowercase();
    if matches!(lower.as_str(), "dm" | "direct message" | "direct messages")
        || lower == handle.agent_name.to_lowercase()
        || lower == handle.agent_id.to_lowercase()
    {
        if let Some(dm) = store.agent_dm_between(owner, &handle.agent_id) {
            if agent_may_reach(store, &handle.agent_id, owner, &dm) {
                return Ok(dm);
            }
        }
        if matches!(lower.as_str(), "dm" | "direct message" | "direct messages") {
            return Err("there are no direct messages between this person and this agent".into());
        }
    }
    let found: Vec<String> = store
        .channel_ids_named(name)
        .into_iter()
        .filter(|cid| agent_may_reach(store, &handle.agent_id, owner, cid))
        .collect();
    match found.len() {
        1 => Ok(found.into_iter().next().unwrap()),
        0 => Err(format!("no conversation called #{name} that this agent is in")),
        _ => Err(format!("#{name} matches more than one conversation; ask the person which group it's in")),
    }
}

/// `word` appears in `text` on its own: not inside a longer name. Channel
/// names may contain `-` and `_`, so those count as part of a word; a
/// leading `#` is fine.
fn contains_word(text: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let inside = |c: char| c.is_alphanumeric() || c == '-' || c == '_';
    let mut from = 0;
    while let Some(pos) = text[from..].find(word) {
        let start = from + pos;
        let end = start + word.len();
        let before_ok = text[..start].chars().next_back().is_none_or(|c| !inside(c));
        let after_ok = text[end..].chars().next().is_none_or(|c| !inside(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + word.len().max(1);
        while !text.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

/// Whether the person named a conversation in the message that started the
/// turn.
#[derive(Debug, PartialEq)]
enum Named {
    Yes,
    /// The spoken name fits more than one conversation in reach, so it
    /// can't unlock any of them.
    Ambiguous(String),
    No,
}

/// The person named this conversation in the message that started the
/// turn: its channel name, or for their DM with this agent, "dm" / "direct
/// message". The grant's own conversation always counts. A channel or id an
/// agent supplies by itself never does. A name counts only if it picks out
/// exactly one conversation this agent can reach for the owner, and that is
/// this one: otherwise a public `#standup` mention would unlock a private
/// channel that happens to share the name.
fn named_check(store: &Store, grant: &TurnGrant, channel_id: &str) -> Named {
    if channel_id == grant.channel_id {
        return Named::Yes;
    }
    let Some(text) = grant.unlock_text.as_deref() else { return Named::No };
    let Some(channel) = store.channel(channel_id) else { return Named::No };
    if channel["kind"] == "agent_dm" {
        let said = contains_word(text, "dm") || contains_word(text, "dms") || text.contains("direct message");
        return if said { Named::Yes } else { Named::No };
    }
    let raw_name = channel["name"].as_str().unwrap_or_default();
    if !contains_word(text, &raw_name.to_lowercase()) {
        return Named::No;
    }
    let reach: Vec<String> = store
        .channel_ids_named(raw_name)
        .into_iter()
        .filter(|cid| agent_may_reach(store, &grant.agent_id, &grant.owner, cid))
        .collect();
    match reach.as_slice() {
        [only] if only == channel_id => Named::Yes,
        [_] | [] => Named::No,
        _ => Named::Ambiguous(raw_name.to_string()),
    }
}

fn person_named(store: &Store, grant: &TurnGrant, channel_id: &str) -> bool {
    named_check(store, grant, channel_id) == Named::Yes
}

/// Refusal when the conversation isn't (uniquely) named by the person.
fn not_named_error(store: &Store, grant: &TurnGrant, channel_id: &str) -> Option<String> {
    match named_check(store, grant, channel_id) {
        Named::Yes => None,
        Named::Ambiguous(name) => Some(format!(
            "#{name} matches more than one conversation; ask the person which group it's in"
        )),
        Named::No => Some(unnamed_elsewhere(store, channel_id)),
    }
}

/// Refusal for acting in another conversation the person didn't name. Says
/// nothing about any schedule there.
fn unnamed_elsewhere(store: &Store, channel_id: &str) -> String {
    if is_public_channel(store, channel_id) {
        let name = store.channel(channel_id).and_then(|c| c["name"].as_str().map(str::to_string)).unwrap_or_default();
        format!("that is in #{name}; the person has to mention #{name} in their message to act there")
    } else {
        PRIVATE_UNNAMED.to_string()
    }
}

/// A regular channel in a public group: anyone may read it, so a reply
/// elsewhere can mention its schedules. Private channels and DMs are not.
fn is_public_channel(store: &Store, channel_id: &str) -> bool {
    store.channel(channel_id).is_some_and(|c| {
        c["kind"] == "channel"
            && c["group_id"].as_str().and_then(|g| store.group(g)).is_some_and(|g| g["is_public"] == true)
    })
}

/// Refusal for a private schedule elsewhere that the person didn't name. It
/// says nothing about the schedule, so the reply can't reveal it.
const PRIVATE_UNNAMED: &str = "that schedule is in a private conversation; ask about it by name to manage it";

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
                // Only the start of the message is kept: enough to find the
                // conversations the person named, without holding up to
                // MAX_GRANTS full message bodies in memory for two hours.
                unlock_text: (!scheduled).then(|| {
                    message["text"].as_str().unwrap_or_default().chars().take(UNLOCK_TEXT_MAX_CHARS).collect::<String>().to_lowercase()
                }),
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

    /// Whether a scheduled post addresses a member agent that has no live
    /// connection right now: one it @mentions (by id or by name), or the
    /// agent of an agent DM. Mirrors fan-out's matching, but resolves names
    /// from the stored agent rows so an offline agent's name still counts.
    fn mentioned_agent_offline(&self, message: &Value) -> bool {
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        let Some(channel) = self.store.channel(channel_id) else { return false };
        let agent_ids = self.store.agents_for_channel(channel_id);
        if channel["kind"] == "agent_dm" {
            return agent_ids.iter().any(|id| self.agent_handle(id).is_none());
        }
        let text = message["text"].as_str().unwrap_or_default();
        if super::mention_raw_tokens(text).is_empty() {
            return false;
        }
        let names: Vec<(String, String, String)> = agent_ids
            .iter()
            .map(|id| {
                let name = self.store.agent(id).and_then(|a| a["name"].as_str().map(str::to_string)).unwrap_or_default();
                (id.clone(), id.to_lowercase(), crate::store::slugify(&name))
            })
            .collect();
        let known: std::collections::HashSet<String> = names
            .iter()
            .flat_map(|(_, id, slug)| [id.clone(), slug.clone()])
            .filter(|t| !t.is_empty())
            .collect();
        let tokens = super::resolved_mention_tokens(text, &known);
        names.iter().any(|(id, id_lc, slug)| {
            (tokens.contains(id_lc) || (!slug.is_empty() && tokens.contains(slug))) && self.agent_handle(id).is_none()
        })
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
            // Checked before delivery: fan-out silently skips agents with no
            // live socket, so this is the only place the miss is visible.
            let missed = self.mentioned_agent_offline(&message);
            self.deliver_scheduled(&message);
            self.store.mark_fire_delivered(&id, due_at);
            // A successful fire clears last_error; flag the miss on the row so
            // the owner sees it rather than a loop that silently stopped.
            let updated = if missed { self.store.set_schedule_error(&id, OFFLINE_AGENT_ERROR).or(updated) } else { updated };
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
        // Same correlation-id rule as usage_request: echo only a sane id.
        if frame["request_id"].as_str().filter(|id| !id.is_empty() && id.len() <= 128).is_none() {
            response["request_id"] = Value::Null;
            response["ok"] = json!(false);
            response["error"] = json!("invalid request_id");
            let _ = handle.tx.send(response);
            return;
        }
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

    /// The conversation this request targets (`channel` by name, or
    /// `channel_id`), among those this agent may reach. None when it names
    /// none. Whether the *person* named it is a separate check
    /// ([`person_named`]).
    fn target_conversation(&self, handle: &AgentHandle, grant: &TurnGrant, frame: &Value) -> Result<Option<String>, String> {
        if let Some(raw) = frame["channel"].as_str().filter(|c| !c.trim().is_empty()) {
            return resolve_named_channel(&self.store, handle, &grant.owner, raw).map(Some);
        }
        match frame["channel_id"].as_str().filter(|c| !c.is_empty()) {
            None => Ok(None),
            Some(c) if c == grant.channel_id => Ok(Some(c.to_string())),
            Some(c) if agent_may_reach(&self.store, &handle.agent_id, &grant.owner, c) => Ok(Some(c.to_string())),
            Some(_) => Err("no conversation with that id that this agent is in".into()),
        }
    }

    fn owned_schedule(&self, handle: &AgentHandle, grant: &TurnGrant, id: &str, frame: &Value) -> Result<Value, String> {
        let schedule = self.store.schedule(id).ok_or("unknown schedule")?;
        // Ownership, not visibility: an agent acting for an admin still only
        // reaches that admin's own schedules.
        if schedule["owner"].as_str() != Some(grant.owner.as_str()) {
            return Err("that schedule belongs to someone else".into());
        }
        // Channel scope: the grant's channel (any thread in it), or another
        // conversation this agent is in and the owner can still reach. A
        // private DM with another agent, or a channel the agent isn't in,
        // stays out of reach.
        let cid = schedule["channel_id"].as_str().unwrap_or_default();
        if cid != grant.channel_id && !agent_may_reach(&self.store, &handle.agent_id, &grant.owner, cid) {
            return Err("that schedule is in a conversation this agent can't manage".into());
        }
        // Another conversation is in reach only when the person named it in
        // the message that started this turn (an agent supplying a channel
        // itself doesn't count): the answer lands here, where others read,
        // and the change acts somewhere the person didn't speak.
        if let Some(refusal) = not_named_error(&self.store, grant, cid) {
            return Err(refusal);
        }
        let _ = frame; // kept for callers; the person's words decide, not the frame
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
                // The conversation the person spoke in, or another one they
                // named in their message. A target that can't be resolved, or
                // that the person didn't name, is refused; it never falls back
                // to this conversation.
                let channel_id = match self.target_conversation(handle, &grant, frame)? {
                    None => grant.channel_id.clone(),
                    Some(c) => match not_named_error(&self.store, &grant, &c) {
                        None => c,
                        Some(refusal) => return Err(refusal),
                    },
                };
                let thread_id = match frame.get("thread_id") {
                    Some(v) if !v.is_null() => Some(v.as_i64().ok_or("thread_id must be a message id")?),
                    Some(_) => None,
                    None if channel_id == grant.channel_id => grant.thread_id,
                    None => None,
                };
                let checked = check_new_schedule(
                    &self.store, &grant.owner, &channel_id, thread_id,
                    frame["text"].as_str().unwrap_or_default(), &frame["schedule"], frame.get("run_at"), now_s,
                )?;
                let created = self.create_checked_schedule(&grant.owner, &checked, Some(&handle.agent_id))?;
                Ok(json!({"schedule": decorate(&created)}))
            }
            "update" => {
                let id = frame["id"].as_str().ok_or("id is required")?;
                let current = self.owned_schedule(handle, &grant, id, frame)?;
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
                let mut change = plan_change(&self.store, &current, &req, now_s).map_err(PlanError::message)?;
                change.rearm_own = scheduled_turn;
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
                let current = self.owned_schedule(handle, &grant, id, frame)?;
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
                let current = self.owned_schedule(handle, &grant, id, frame)?;
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
                // The person's schedules in conversations this agent is part
                // of (any age, any status they ask for), a page at a time.
                // Channels and DMs the agent isn't in stay out of reach, so
                // listing can't leak schedules the agent couldn't see.
                let status = match frame["status"].as_str().unwrap_or("all") {
                    "all" => None,
                    s @ ("active" | "paused" | "done" | "cancelled") => Some(s),
                    other => return Err(format!("unknown status '{other}' (all, active, paused, done, cancelled)")),
                };
                // A conversation the person named in their message is an
                // explicit ask: its schedules come back in full, private or
                // not. One the agent picked by itself only narrows the list:
                // a private one it wasn't asked about is refused outright.
                let only_channel: Option<String> = match frame["channel"].as_str().filter(|c| !c.trim().is_empty()) {
                    Some(raw) => Some(resolve_named_channel(&self.store, handle, &grant.owner, raw)?),
                    None => frame["channel_id"].as_str().filter(|c| !c.is_empty()).map(str::to_string),
                };
                if let Some(c) = only_channel.as_deref() {
                    if !agent_still_in(&self.store, &handle.agent_id, c) {
                        return Err("this agent isn't in that channel".into());
                    }
                }
                let named = only_channel.as_deref().map(|c| named_check(&self.store, &grant, c));
                if let Some(Named::Ambiguous(name)) = &named {
                    return Err(format!("#{name} matches more than one conversation; ask the person which group it's in"));
                }
                let explicit = named == Some(Named::Yes);
                if let Some(c) = only_channel.as_deref() {
                    if !explicit && c != grant.channel_id && !is_public_channel(&self.store, c) {
                        return Err(PRIVATE_UNNAMED.into());
                    }
                }
                let only_channel = only_channel.as_deref();
                let offset = frame["offset"].as_u64().unwrap_or(0) as usize;
                let limit = (frame["limit"].as_u64().unwrap_or(LIST_PAGE_DEFAULT as u64) as usize)
                    .clamp(1, LIST_PAGE_MAX);
                let mut reachable = std::collections::HashMap::<String, bool>::new();
                // Read at most MAX_AGENT_LISTED rows (one extra tells us there
                // were more); the agent pages within that window.
                let raw = self
                    .store
                    .list_owner_schedules_by_status(&grant.owner, status, MAX_AGENT_LISTED + 1);
                let truncated = raw.len() > MAX_AGENT_LISTED;
                let rows: Vec<Value> = raw
                    .into_iter()
                    .take(MAX_AGENT_LISTED)
                    .filter(|s| {
                        let cid = s["channel_id"].as_str().unwrap_or_default();
                        if only_channel.is_some_and(|c| c != cid) {
                            return false;
                        }
                        *reachable
                            .entry(cid.to_string())
                            .or_insert_with(|| agent_still_in(&self.store, &handle.agent_id, cid))
                    })
                    .collect();
                let total = rows.len();
                let decorator = ScheduleDecorator::new(&self.store, None, now_s);
                // The answer lands in the grant's conversation, so a schedule
                // from elsewhere only shows its words when that conversation
                // is a public channel; private channels and DMs keep the text
                // (and thread title) out of a reply others may read.
                let mut public_channel = std::collections::HashMap::<String, bool>::new();
                let items: Vec<Value> = rows
                    .iter()
                    .skip(offset)
                    .take(limit)
                    .map(|s| {
                        let mut item = decorator.decorate(s);
                        let cid = s["channel_id"].as_str().unwrap_or_default();
                        let here = cid == grant.channel_id;
                        let public = here
                            || explicit
                            || *public_channel
                                .entry(cid.to_string())
                                .or_insert_with(|| is_public_channel(&self.store, cid));
                        // Manageable from here: this conversation, or one the
                        // person named in their message that is still in reach.
                        item["manageable_here"] = json!(
                            here || (person_named(&self.store, &grant, cid)
                                && agent_may_reach(&self.store, &handle.agent_id, &grant.owner, cid))
                        );
                        if !public {
                            // Nothing that identifies the conversation either:
                            // its name would tell readers here it exists.
                            for key in [
                                "id", "last_error", "text", "thread_title", "channel_name", "channel_kind",
                                "group_id", "channel_id", "thread_id", "via_agent", "text_agent", "updated_by",
                                "created_by", "owner_name",
                            ] {
                                item[key] = Value::Null;
                            }
                            item["conversation"] = json!("private");
                            item["text_hidden"] = json!(true);
                            // Hidden rows carry no id, so nothing to act on.
                            item["manageable_here"] = json!(false);
                        }
                        item
                    })
                    .collect();
                let has_more = offset + items.len() < total;
                let mut out = json!({
                    "items": items,
                    "total": total,
                    "offset": offset,
                    "has_more": has_more,
                    "next_offset": if has_more { json!(offset + items.len()) } else { Value::Null },
                });
                if truncated {
                    out["truncated"] = json!(true);
                }
                Ok(out)
            }
            "get" => {
                // One schedule in full, message included. Same reach as `list`:
                // the person's own, in a conversation this agent is still in.
                // Its words come back only where `list` would show them: this
                // conversation, a public channel, or one the person named in
                // their message (the answer lands here, where others may read).
                // A scheduled run may read only its own schedule.
                let id = frame["id"].as_str().ok_or("id is required")?;
                let current = self.store.schedule(id).ok_or("unknown schedule")?;
                if current["owner"].as_str() != Some(grant.owner.as_str()) {
                    return Err("that schedule belongs to someone else".into());
                }
                if grant.schedule_id.as_deref().is_some_and(|only| only != id) {
                    return Err("this turn may only re-arm or cancel its own schedule".into());
                }
                let cid = current["channel_id"].as_str().unwrap_or_default();
                let here = cid == grant.channel_id;
                if !here && !agent_still_in(&self.store, &handle.agent_id, cid) {
                    return Err("that schedule is in a conversation this agent can't manage".into());
                }
                if !here && !is_public_channel(&self.store, cid) {
                    if let Some(refusal) = not_named_error(&self.store, &grant, cid) {
                        return Err(refusal);
                    }
                }
                let mut item = decorate(&current);
                item["manageable_here"] = json!(
                    here || (person_named(&self.store, &grant, cid)
                        && agent_may_reach(&self.store, &handle.agent_id, &grant.owner, cid))
                );
                Ok(json!({"schedule": item}))
            }
            other => Err(format!("unknown op '{other}' (create, update, pause, resume, cancel, list, get)")),
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
            ("get", json!({"id": other["id"]})),
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
        // `at` comes back from stored JSON text (last-bit float drift).
        assert!((rearmed["schedule"]["schedule"]["at"].as_f64().unwrap() - next).abs() < 1e-3);
        // It may read its own schedule back in full.
        let own = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": s["id"]})));
        assert_eq!(own["schedule"]["text"], "@claude LOOP demo · run 2", "{own}");
        let cancelled = ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": s["id"]})));
        assert_eq!(cancelled["schedule"]["status"], "cancelled");
    }

    #[test]
    fn a_person_confirmed_schedule_lets_each_tagged_agent_only_rearm_it() {
        // What Jarvis stores once the person confirms: their own schedule
        // (no writing agent), tagging two agents.
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let mut codex = add_agent(&h, "codex", "Codex", false);
        let cid = setup_channel(&h, &["claude", "codex"]);
        let gid = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        h.store.add_member(&gid, "user", "tom", "member", None);
        let at = now() + 400.0;
        let checked = check_new_schedule(&h.store, "tom", &cid, None, "@claude @codex LOOP review · run 1",
            &json!({"kind": "once", "at": at}), None, now()).unwrap();
        let s = h.create_checked_schedule("tom", &checked, None).unwrap();
        assert!(s["via_agent"].is_null());
        assert_eq!(h.fire_due_schedules(at + 1.0), 1);
        let mut turns = Vec::new();
        for rx in [&mut claude, &mut codex] {
            let inbound = last_frame(rx, "inbound").unwrap();
            assert_eq!((inbound["scheduled"].as_bool(), &inbound["schedule_id"]), (Some(true), &s["id"]), "{inbound}");
            turns.push(inbound["turn_id"].as_str().expect("each tagged agent gets the narrow grant").to_string());
        }
        // Narrow: no new schedules or listing for either agent.
        for (rx, agent, turn) in [(&mut claude, "claude", &turns[0]), (&mut codex, "codex", &turns[1])] {
            let r = ask(&h, rx, req(agent, turn, "create", json!({"text": "x", "schedule": {"kind": "interval", "seconds": 600}})));
            assert_eq!(r["ok"], false, "{r}");
        }
        // Either may re-arm its own schedule.
        let next = now() + 3600.0;
        let rearmed = ask(&h, &mut codex, req("codex", &turns[1], "update", json!({
            "id": s["id"], "text": "@claude @codex LOOP review · run 2", "run_at": next})));
        assert_eq!((rearmed["ok"].as_bool(), rearmed["schedule"]["status"].as_str()), (Some(true), Some("active")), "{rearmed}");
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
        // A channel this agent isn't in can't be targeted, and nothing falls
        // back to this conversation.
        assert!(elsewhere["error"].as_str().unwrap().contains("this agent is in"), "{elsewhere}");
        assert!(h.store.list_schedules_for_channel(&cid, None).is_empty(), "nothing created here");
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
        assert!((made["schedule"]["schedule"]["at"].as_f64().unwrap() - when).abs() < 1e-3);
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
            // The agent isn't in that channel: out of reach.
            assert!(r["error"].as_str().unwrap().contains("can't manage"), "{op}: {r}");
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
                    expires_at: now() + 10.0 + i as f64, ops: 0, unlock_text: None,
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
        // Extra spacing is the same rule, not a cadence change.
        let spaced = json!({"kind": "cron", "expr": "0  7 *  * *"});
        let req = ChangeRequest { schedule: Some(&spaced), ..Default::default() };
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

    fn once_at(h: &Hub, owner: &str, cid: &str, text: &str, at: f64) -> String {
        h.store.create_schedule(owner, cid, None, text, at, &json!({"kind": "once", "at": at}), owner, None)
            ["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn agent_list_reads_at_most_the_cap_and_says_so() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let done = ScheduleChange { status: Some("done".into()), ..Default::default() };
        for i in 0..=MAX_AGENT_LISTED {
            let id = once_at(&h, "tom", &cid, &format!("old {i}"), now() + 600.0 + i as f64);
            h.store.update_schedule(&id, &done, "tom", None).unwrap();
        }
        let live = once_at(&h, "tom", &cid, "still live", now() + 5_000.0);
        h.post_user_message(&cid, "what's scheduled?", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["total"], MAX_AGENT_LISTED, "the read stops at the cap");
        assert_eq!(r["truncated"], true);
        assert_eq!(r["items"][0]["id"], live.as_str(), "live-first, so the cap never hides a live one");
        // Under the cap there's no flag.
        let small = hub();
        people(&small);
        let mut c2 = add_agent(&small, "claude", "Claude", false);
        let cid2 = setup_channel(&small, &["claude"]);
        once_at(&small, "tom", &cid2, "one", now() + 600.0);
        small.post_user_message(&cid2, "list", "tom", Some("Tom"), None, vec![]);
        let t2 = last_frame(&mut c2, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r2 = ask(&small, &mut c2, req("claude", &t2, "list", json!({})));
        assert!(r2.get("truncated").is_none(), "{r2}");
    }

    #[test]
    fn agent_list_pages_filters_and_spans_the_agents_channels() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let also = {
            let g = h.store.create_group("G-ops", "", Some("tom"));
            let gid = g["id"].as_str().unwrap().to_string();
            h.store.add_member(&gid, "agent", "claude", "member", None);
            h.store.create_channel(&gid, "ops", "")["id"].as_str().unwrap().to_string()
        };
        let hidden = setup_channel(&h, &[]);
        let done = ScheduleChange { status: Some("done".into()), ..Default::default() };
        let paused = ScheduleChange { status: Some("paused".into()), ..Default::default() };
        for i in 0..25 {
            once_at(&h, "tom", &cid, &format!("active {i}"), now() + 600.0 + i as f64);
        }
        let p = once_at(&h, "tom", &also, "paused one", now() + 900.0);
        h.store.update_schedule(&p, &paused, "tom", None).unwrap();
        // Finished long ago: past the 7-day window people's lists use.
        let old = once_at(&h, "tom", &cid, "ancient report", now() + 700.0);
        h.store.update_schedule(&old, &done, "tom", None).unwrap();
        h.store.backdate_schedule_for_test(&old, now() - 30.0 * 86_400.0);
        once_at(&h, "tom", &hidden, "elsewhere", now() + 600.0);
        once_at(&h, "bob", &cid, "not tom's", now() + 600.0);
        h.post_user_message(&cid, "what's scheduled?", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();

        let first = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(first["total"], 27, "25 active + paused + the old finished one, not the hidden channel or bob's");
        assert_eq!(first["items"].as_array().unwrap().len(), LIST_PAGE_DEFAULT);
        assert_eq!(first["has_more"], true);
        assert_eq!(first["next_offset"], LIST_PAGE_DEFAULT);
        assert_eq!(first["items"][0]["status"], "active", "live first");
        let second = ask(&h, &mut claude, req("claude", &turn, "list", json!({"offset": first["next_offset"]})));
        assert_eq!(second["items"].as_array().unwrap().len(), 7);
        assert_eq!(second["has_more"], false);
        assert!(second["next_offset"].is_null());
        let finished = ask(&h, &mut claude, req("claude", &turn, "list", json!({"status": "done"})));
        assert_eq!(finished["total"], 1);
        assert_eq!(finished["items"][0]["text"], "ancient report");
        h.post_user_message(&cid, "anything paused in #ops?", "tom", Some("Tom"), None, vec![]);
        let ops_turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let only_paused = ask(&h, &mut claude, req("claude", &ops_turn, "list", json!({"status": "paused", "channel_id": also})));
        assert_eq!(only_paused["total"], 1);
        // Naming that conversation is an explicit ask: full details, and the
        // agent may manage it from here (it's in that channel too).
        assert_eq!(only_paused["items"][0]["text"], "paused one");
        assert!(only_paused["items"][0].get("text_hidden").is_none());
        assert_eq!(only_paused["items"][0]["manageable_here"], true);
        assert_eq!(first["items"][0]["manageable_here"], true);
        let big = ask(&h, &mut claude, req("claude", &turn, "list", json!({"limit": 500})));
        assert_eq!(big["items"].as_array().unwrap().len(), LIST_PAGE_MAX.min(27));
        let peek = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel_id": hidden})));
        assert!(peek["error"].as_str().unwrap().contains("isn't in that channel"), "{peek}");
        let bad = ask(&h, &mut claude, req("claude", &turn, "list", json!({"status": "nope"})));
        assert!(bad["error"].as_str().unwrap().contains("unknown status"), "{bad}");
    }

    #[test]
    fn a_loop_re_arming_itself_does_not_spend_the_hourly_create_budget() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        let id = once_at(&h, "tom", &cid, "@claude LOOP demo", now() - 1.0);
        // More re-arms than the hourly create/revive limit allows.
        for run in 0..(crate::store::MAX_CREATES_PER_HOUR + 10) {
            if run > 0 {
                // Fast-forward: the re-armed run comes due.
                h.store.update_schedule(&id, &ScheduleChange { run_at: Some(now() - 1.0), ..Default::default() }, "tom", None);
            }
            assert_eq!(h.fire_due_schedules(now()), 1, "run {run} fired");
            let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
            let r = ask(&h, &mut claude, req("claude", &turn, "update", json!({"id": id, "run_at": now() + 600.0})));
            assert_eq!(r["ok"], true, "re-arm {run}: {r}");
        }
        // The person's own budget is untouched: a fresh request still works.
        h.post_user_message(&cid, "also remind me", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let made = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "reminder", "schedule": {"kind": "once", "at": now() + 900.0}})));
        assert_eq!(made["ok"], true, "{made}");
    }

    #[test]
    fn get_returns_one_schedule_in_full_only_where_list_would_show_it() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let room = |group: &str, name: &str, public: bool| {
            let g = h.store.create_group(group, "", Some("tom"));
            let gid = g["id"].as_str().unwrap().to_string();
            if public {
                h.store.set_group_public(&gid, true);
            }
            h.store.add_member(&gid, "agent", "claude", "member", None);
            h.store.create_channel(&gid, name, "")["id"].as_str().unwrap().to_string()
        };
        let here = room("G-here", "general", true);
        let open = room("G-open", "town", true);
        let private = room("G-exec", "exec-comp", false);
        // Two private channels share a name: naming it is ambiguous.
        let twin_a = room("G-a", "ops", false);
        room("G-b", "ops", false);
        let elsewhere_g = h.store.create_group("G-other", "", Some("tom"));
        let not_in = h.store.create_channel(elsewhere_g["id"].as_str().unwrap(), "secret-room", "")["id"]
            .as_str().unwrap().to_string();
        h.store.set_agent_dm_policy("claude", true, &[]);
        let dm = h.store.open_agent_dm("tom", "claude", "Claude")["id"].as_str().unwrap().to_string();
        let long = "@claude-cli LOOP demo · run 1\n\nSCHEDULER: line two\nline three";
        let mine = once_at(&h, "tom", &here, long, now() + 600.0);
        let public = once_at(&h, "tom", &open, "public text", now() + 610.0);
        let exec = once_at(&h, "tom", &private, "private text", now() + 620.0);
        let twin = once_at(&h, "tom", &twin_a, "ops text", now() + 625.0);
        let dm_s = once_at(&h, "tom", &dm, "dm secret", now() + 630.0);
        let unreachable = once_at(&h, "tom", &not_in, "never shown", now() + 640.0);
        let bobs = once_at(&h, "bob", &here, "bob's", now() + 650.0);
        h.post_user_message(&here, "what's in my schedule?", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();

        // Its own conversation: everything, the full multi-line text included.
        let r = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": mine})));
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["schedule"]["text"], long);
        assert_eq!(r["schedule"]["manageable_here"], true);
        assert!(r["schedule"]["next_runs"].as_array().is_some_and(|n| !n.is_empty()));
        // A public channel elsewhere reads like list shows it, but isn't manageable unnamed.
        let r = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": public})));
        assert_eq!(r["schedule"]["text"], "public text", "{r}");
        assert_eq!(r["schedule"]["manageable_here"], false);
        // Someone else's, unknown, not reachable, private unnamed, DM unnamed: refused, nothing leaks.
        for (id, leak) in [
            (bobs.as_str(), "bob's"), ("nope", "nope-text"), (unreachable.as_str(), "never shown"),
            (exec.as_str(), "private text"), (dm_s.as_str(), "dm secret"),
        ] {
            let r = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": id})));
            assert_eq!(r["ok"], false, "{id} should be refused: {r}");
            let body = r.to_string();
            for l in [leak, "exec-comp", &private, &dm] {
                assert!(!body.contains(l), "leaked {l}: {body}");
            }
        }
        let missing = ask(&h, &mut claude, req("claude", &turn, "get", json!({})));
        assert_eq!(missing["error"], "id is required");

        // Named by the person: the private channel and the DM read in full.
        h.post_user_message(&here, "show my #exec-comp schedule and the one in our DM", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": exec})));
        assert_eq!(r["schedule"]["text"], "private text", "{r}");
        assert_eq!(r["schedule"]["manageable_here"], true);
        let r = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": dm_s})));
        assert_eq!(r["schedule"]["text"], "dm secret", "{r}");

        // A name two private channels share is refused, not guessed.
        h.post_user_message(&here, "show my #ops schedule", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": twin})));
        assert_eq!(r["ok"], false, "{r}");
        assert!(r["error"].as_str().unwrap().contains("more than one"), "{r}");
        assert!(!r.to_string().contains("ops text"));

        // Cancelled schedules still read back, with their status.
        let gone = ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": mine})));
        assert_eq!(gone["ok"], true, "{gone}");
        let r = ask(&h, &mut claude, req("claude", &turn, "get", json!({"id": mine})));
        assert_eq!(r["schedule"]["status"], "cancelled", "{r}");
    }

    #[test]
    fn listing_from_one_conversation_hides_the_words_of_private_ones() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let named = |name: &str, public: bool| {
            let g = h.store.create_group(&format!("G-{name}"), "", Some("tom"));
            let gid = g["id"].as_str().unwrap().to_string();
            if public {
                h.store.set_group_public(&gid, true);
            }
            h.store.add_member(&gid, "agent", "claude", "member", None);
            h.store.create_channel(&gid, name, "")["id"].as_str().unwrap().to_string()
        };
        let here = named("general", true);
        let open = named("town", true);
        let private = named("exec-comp", false);
        let elsewhere_g = h.store.create_group("G-other", "", Some("tom"));
        let not_in = h.store.create_channel(elsewhere_g["id"].as_str().unwrap(), "secret-room", "")["id"]
            .as_str().unwrap().to_string();
        h.store.set_agent_dm_policy("claude", true, &[]);
        let dm = h.store.open_agent_dm("tom", "claude", "Claude")["id"].as_str().unwrap().to_string();
        once_at(&h, "tom", &here, "here text", now() + 600.0);
        once_at(&h, "tom", &open, "public text", now() + 610.0);
        let exec = once_at(&h, "tom", &private, "private text", now() + 620.0);
        once_at(&h, "tom", &dm, "dm secret", now() + 630.0);
        once_at(&h, "tom", &not_in, "never listed", now() + 640.0);
        h.post_user_message(&here, "what have I got?", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();

        // Default list from public #general: private rows say nothing about where they are.
        let r = ask(&h, &mut claude, req("claude", &turn, "list", json!({})));
        assert_eq!(r["total"], 4, "the channel the agent isn't in is never listed: {r}");
        let items = r["items"].as_array().unwrap();
        let by_channel = |c: &str| items.iter().find(|i| i["channel_id"] == c).cloned().unwrap();
        assert_eq!(by_channel(&here)["text"], "here text");
        assert_eq!(by_channel(&here)["manageable_here"], true);
        assert_eq!(by_channel(&open)["text"], "public text");
        let hidden: Vec<&Value> = items.iter().filter(|i| i["conversation"] == "private").collect();
        assert_eq!(hidden.len(), 2, "the private channel and the DM");
        for item in hidden {
            assert_eq!(item["text_hidden"], true);
            assert!(item["channel_id"].is_null() && item["channel_name"].is_null() && item["group_id"].is_null(), "{item}");
            for key in ["id", "last_error", "via_agent", "text_agent", "updated_by", "created_by", "owner_name"] {
                assert!(item[key].is_null(), "{key} identifies the hidden row: {item}");
            }
            assert_eq!(item["manageable_here"], false, "a hidden row has to be named first: {item}");
            assert!(item["next_runs"].as_array().is_some_and(|n| !n.is_empty()), "cadence still shown");
        }
        let body = r.to_string();
        for leak in ["dm secret", "private text", "exec-comp", &private, &dm, "never listed"] {
            assert!(!body.contains(leak), "leaked {leak}: {body}");
        }

        // The agent naming it by itself doesn't count: the person didn't ask.
        for target in ["#exec-comp", "dm"] {
            let r = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel": target})));
            assert_eq!(r["ok"], false, "{target} unlocked without the person naming it: {r}");
            let body = r.to_string();
            for leak in ["private text", "dm secret", &private, &dm] {
                assert!(!body.contains(leak), "leaked {leak}: {body}");
            }
        }
        let by_id = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel_id": private})));
        assert_eq!(by_id["ok"], false, "an id the agent supplies itself doesn't unlock: {by_id}");

        // Managing it from #general when the person didn't name it is refused,
        // saying nothing about it.
        for (op, extra) in [
            ("pause", json!({"id": exec})),
            ("update", json!({"id": exec, "text": "private text v2"})),
            ("cancel", json!({"id": exec, "channel": "#exec-comp"})),
        ] {
            let r = ask(&h, &mut claude, req("claude", &turn, op, extra));
            assert_eq!(r["ok"], false, "{op} needs the person to name the conversation: {r}");
            assert!(r["error"].as_str().unwrap().contains("ask about it by name"), "{r}");
            let body = r.to_string();
            for leak in ["private text", "exec-comp", &private] {
                assert!(!body.contains(leak), "{op} leaked {leak}: {body}");
            }
        }
        assert_eq!(h.store.schedule(&exec).unwrap()["status"], "active", "nothing changed");

        // The person names it: full details, and it can be managed from here.
        h.post_user_message(&here, "show my #exec-comp and DM schedules, then pause the exec-comp one",
            "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let named_r = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel": "#exec-comp"})));
        assert_eq!(named_r["ok"], true, "{named_r}");
        assert_eq!(named_r["items"][0]["text"], "private text");
        assert_eq!(named_r["items"][0]["channel_name"], "exec-comp");
        assert_eq!(named_r["items"][0]["manageable_here"], true);
        let dm_r = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel": "dm"})));
        assert_eq!(dm_r["items"][0]["text"], "dm secret", "{dm_r}");
        let paused = ask(&h, &mut claude, req("claude", &turn, "pause", json!({"id": exec})));
        assert_eq!(paused["schedule"]["status"], "paused", "{paused}");
        assert_eq!(paused["schedule"]["channel_name"], "exec-comp");
        let resumed = ask(&h, &mut claude, req("claude", &turn, "resume", json!({"id": exec})));
        assert_eq!(resumed["ok"], true, "{resumed}");
        let moved = ask(&h, &mut claude, req("claude", &turn, "update", json!({"id": exec, "text": "private text v2"})));
        assert_eq!(moved["schedule"]["text"], "private text v2", "{moved}");
        let gone = ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": exec})));
        assert_eq!(gone["schedule"]["status"], "cancelled");

        // Naming a different conversation doesn't unlock this one, and a
        // public channel elsewhere also needs naming before it's changed.
        let exec2 = once_at(&h, "tom", &private, "private again", now() + 950.0);
        let town = once_at(&h, "tom", &open, "town again", now() + 900.0);
        h.post_user_message(&here, "pause the one in #town", "tom", Some("Tom"), None, vec![]);
        let turn_town = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        assert_eq!(ask(&h, &mut claude, req("claude", &turn_town, "cancel", json!({"id": exec2})))["ok"], false);
        let t = ask(&h, &mut claude, req("claude", &turn_town, "pause", json!({"id": town})));
        assert_eq!(t["schedule"]["status"], "paused", "{t}");
        h.post_user_message(&here, "thanks", "tom", Some("Tom"), None, vec![]);
        let turn_plain = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn_plain, "resume", json!({"id": town})));
        assert!(r["error"].as_str().unwrap().contains("mention #town"), "{r}");

        // A conversation the agent isn't in, or an unknown name, stays out of reach.
        let refused = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel": "secret-room"})));
        assert_eq!(refused["ok"], false);
        assert!(!refused.to_string().contains("never listed"));
        let unknown = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel": "nope"})));
        assert!(unknown["error"].as_str().unwrap().contains("no conversation called #nope"), "{unknown}");
    }

    #[test]
    fn create_follows_the_conversation_the_person_named() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let room = |name: &str| {
            let g = h.store.create_group(&format!("G-{name}"), "", Some("tom"));
            let gid = g["id"].as_str().unwrap().to_string();
            h.store.add_member(&gid, "agent", "claude", "member", None);
            h.store.create_channel(&gid, name, "")["id"].as_str().unwrap().to_string()
        };
        let here = room("general");
        let ops = room("ops");
        let ops_root = h.post_user_message(&ops, "release thread", "tom", Some("Tom"), None, vec![]);
        let ops_tid = ops_root["id"].as_i64().unwrap();
        let mk = |turn: &str, extra: Value| {
            let mut f = req("claude", turn, "create", json!({
                "text": "@claude LOOP ops check", "schedule": {"kind": "interval", "seconds": 600}}));
            if let Value::Object(map) = extra {
                for (k, v) in map {
                    f[k] = v;
                }
            }
            f
        };
        // The person names #ops: it's created there (and in a thread there).
        h.post_user_message(&here, "schedule a daily check in #ops", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let made = ask(&h, &mut claude, mk(&turn, json!({"channel": "#ops"})));
        assert_eq!(made["schedule"]["channel_id"], ops.as_str(), "{made}");
        let threaded = ask(&h, &mut claude, mk(&turn, json!({"channel_id": ops, "thread_id": ops_tid})));
        assert_eq!(threaded["schedule"]["thread_id"], ops_tid, "{threaded}");
        // The person didn't name it: refused, even with the agent supplying
        // the name or id itself, and nothing lands here instead.
        h.post_user_message(&here, "schedule a daily check", "tom", Some("Tom"), None, vec![]);
        let plain = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        for extra in [json!({"channel": "#ops"}), json!({"channel_id": ops})] {
            let r = ask(&h, &mut claude, mk(&plain, extra.clone()));
            assert_eq!(r["ok"], false, "{extra}: {r}");
        }
        // Unknown or not-a-member targets are refused too.
        let unknown = ask(&h, &mut claude, mk(&turn, json!({"channel": "#nope"})));
        assert!(unknown["error"].as_str().unwrap().contains("no conversation called #nope"), "{unknown}");
        assert!(h.store.list_schedules_for_channel(&here, None).is_empty(), "nothing fell back to this conversation");
        // No target: this conversation, as before.
        let local = ask(&h, &mut claude, mk(&plain, json!({})));
        assert_eq!(local["schedule"]["channel_id"], here.as_str(), "{local}");
    }

    #[test]
    fn a_name_counts_only_as_a_whole_word() {
        assert!(contains_word("pause the #ops loop", "ops"));
        assert!(contains_word("ops: pause it", "ops"));
        assert!(!contains_word("pause the devops loop", "ops"));
        assert!(!contains_word("check ops-review", "ops"));
        assert!(contains_word("check ops-review", "ops-review"));
        assert!(contains_word("my dm one", "dm"));
        assert!(!contains_word("admin stuff", "dm"));
    }

    #[test]
    fn a_bad_request_id_is_not_echoed_and_does_nothing() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let cid = setup_channel(&h, &["claude"]);
        h.post_user_message(&cid, "hi", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        for bad in [json!(""), json!("x".repeat(129)), json!(42), Value::Null] {
            let mut f = req("claude", &turn, "create", json!({
                "text": "x", "schedule": {"kind": "interval", "seconds": 600}}));
            f["request_id"] = bad.clone();
            let r = ask(&h, &mut claude, f);
            assert_eq!(r["ok"], false, "{bad}: {r}");
            assert!(r["request_id"].is_null());
            assert_eq!(r["error"], "invalid request_id");
        }
        assert!(h.store.list_schedules_for_channel(&cid, None).is_empty(), "nothing was created");
    }

    #[test]
    fn an_ambiguous_channel_name_is_refused_and_create_stays_in_this_conversation() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let mk = |group: &str| {
            let g = h.store.create_group(group, "", Some("tom"));
            let gid = g["id"].as_str().unwrap().to_string();
            h.store.add_member(&gid, "agent", "claude", "member", None);
            h.store.create_channel(&gid, "standup", "")["id"].as_str().unwrap().to_string()
        };
        let a = mk("A");
        let b = mk("B");
        once_at(&h, "tom", &b, "in b", now() + 600.0);
        h.post_user_message(&a, "hi", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let r = ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel": "standup"})));
        assert!(r["error"].as_str().unwrap().contains("more than one"), "{r}");
        assert!(!r.to_string().contains("in b"));
        let made = ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "x", "schedule": {"kind": "interval", "seconds": 600}, "channel_id": b})));
        assert_eq!(made["ok"], false, "create stays in the grant's conversation: {made}");
    }

    #[test]
    fn a_spoken_name_shared_by_two_conversations_unlocks_neither() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let group = |name: &str| {
            let g = h.store.create_group(name, "", Some("tom"));
            let gid = g["id"].as_str().unwrap().to_string();
            h.store.add_member(&gid, "agent", "claude", "member", None);
            gid
        };
        let (ga, gb, gc) = (group("A"), group("B"), group("C"));
        let standup_a = h.store.create_channel(&ga, "standup", "")["id"].as_str().unwrap().to_string();
        let standup_b = h.store.create_channel(&gb, "standup", "")["id"].as_str().unwrap().to_string();
        let ops = h.store.create_channel(&gb, "ops", "")["id"].as_str().unwrap().to_string();
        let general = h.store.create_channel(&gc, "general", "")["id"].as_str().unwrap().to_string();
        let _ = standup_a;
        let in_b = once_at(&h, "tom", &standup_b, "secret standup note", now() + 600.0);
        let in_ops = once_at(&h, "tom", &ops, "ops note", now() + 600.0);
        h.post_user_message(&general, "pause my standup and ops schedules", "tom", Some("Tom"), None, vec![]);
        let turn = last_frame(&mut claude, "inbound").unwrap()["turn_id"].as_str().unwrap().to_string();
        let ambiguous = |r: &Value| {
            assert_eq!(r["ok"], false, "{r}");
            assert!(r["error"].as_str().unwrap().contains("more than one"), "{r}");
            assert!(!r.to_string().contains("secret standup note"), "{r}");
        };
        // By bare id, by channel_id, and for create: the shared name unlocks nothing.
        ambiguous(&ask(&h, &mut claude, req("claude", &turn, "pause", json!({"id": in_b}))));
        ambiguous(&ask(&h, &mut claude, req("claude", &turn, "cancel", json!({"id": in_b}))));
        ambiguous(&ask(&h, &mut claude, req("claude", &turn, "list", json!({"channel_id": standup_b}))));
        let live_before = h.store.count_live_schedules("tom");
        ambiguous(&ask(&h, &mut claude, req("claude", &turn, "create", json!({
            "text": "x", "schedule": {"kind": "interval", "seconds": 600}, "channel_id": standup_b}))));
        assert_eq!(h.store.count_live_schedules("tom"), live_before, "nothing created anywhere");
        assert_eq!(h.store.schedule(&in_b).unwrap()["status"], "active");
        // A name only one conversation has still works.
        let paused = ask(&h, &mut claude, req("claude", &turn, "pause", json!({"id": in_ops})));
        assert_eq!(paused["ok"], true, "{paused}");
    }

    #[test]
    fn only_the_start_of_a_long_message_is_kept_for_unlocking() {
        let h = hub();
        people(&h);
        let mut claude = add_agent(&h, "claude", "Claude", false);
        let here = setup_channel(&h, &["claude"]);
        let gid = h.store.channel(&here).unwrap()["group_id"].as_str().unwrap().to_string();
        let ops = h.store.create_channel(&gid, "ops", "")["id"].as_str().unwrap().to_string();
        let in_ops = once_at(&h, "tom", &ops, "ops note", now() + 600.0);
        let long = format!("pause my ops schedule. {}", "x".repeat(UNLOCK_TEXT_MAX_CHARS * 2));
        h.post_user_message(&here, &long, "tom", Some("Tom"), None, vec![]);
        let inbound = last_frame(&mut claude, "inbound").unwrap();
        let turn = inbound["turn_id"].as_str().unwrap().to_string();
        let kept = h.state.lock().unwrap().grants.get(&turn).unwrap().unlock_text.clone().unwrap();
        assert_eq!(kept.chars().count(), UNLOCK_TEXT_MAX_CHARS);
        let paused = ask(&h, &mut claude, req("claude", &turn, "pause", json!({"id": in_ops})));
        assert_eq!(paused["ok"], true, "{paused}");
    }

    #[test]
    fn a_post_that_mentions_an_offline_agent_flags_the_schedule() {
        let h = hub();
        people(&h);
        let _claude = add_agent(&h, "claude", "Claude", false);
        // Codex is a member but its bridge isn't connected.
        h.store.upsert_agent("codex", "Codex", "test", false, false, 0);
        let cid = setup_channel(&h, &["claude", "codex"]);
        let every = |text: &str| {
            let at = now() - 1.0;
            h.store.create_schedule("tom", &cid, None, text, at, &json!({"kind": "interval", "seconds": 600}), "tom", None)
                ["id"].as_str().unwrap().to_string()
        };
        let both = every("@claude @codex daily check");
        let fine = every("@claude only");
        let nobody = every("a note for people");
        assert_eq!(h.fire_due_schedules(now()), 3);
        let err = |id: &str| h.store.schedule(id).unwrap()["last_error"].clone();
        assert_eq!(err(&both), OFFLINE_AGENT_ERROR, "one of several mentioned agents was offline");
        assert!(!OFFLINE_AGENT_ERROR.contains("odex"), "the message never names agents");
        assert!(err(&fine).is_null());
        assert!(err(&nobody).is_null());
        // Codex reconnects; the next fire clears the warning.
        let _codex = add_agent(&h, "codex", "Codex", false);
        h.store.update_schedule(&both, &ScheduleChange { run_at: Some(now() - 1.0), ..Default::default() }, "tom", None);
        assert_eq!(h.fire_due_schedules(now() + 1.0), 1);
        assert!(err(&both).is_null(), "{}", err(&both));
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
