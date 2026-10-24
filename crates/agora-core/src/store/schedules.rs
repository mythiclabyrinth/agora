//! Scheduled messages: rows that post into a channel/thread *as their owner*
//! at a due time — once, every N seconds, or on a cron pattern (the
//! `schedule` spec, see [`crate::schedule_spec`]). `run_at` is always the
//! next due time.
//!
//! Firing is split in two so a crash can never post twice or lose a post:
//! [`Store::record_fire`] commits the message row, a `schedule_fires` row
//! keyed `(schedule_id, due_at)` and the schedule's advance in ONE
//! transaction; the hub then runs the live side effects (broadcast, agent
//! fan-out) and marks the fire delivered. A restart replays side effects for
//! fires committed but never marked delivered.

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::{new_token, now, Store};
use crate::schedule_spec::{fmt_utc, Spec};

/// Active+paused schedules one person may hold — caps the damage a runaway
/// agent turn can do on someone's behalf.
pub const MAX_LIVE_PER_OWNER: i64 = 200;
/// Schedules created for one person in any rolling hour. Finished one-offs
/// stop counting toward the live cap, so without this a runaway turn could
/// keep creating "once, now" schedules and post in their name every tick.
pub const MAX_CREATES_PER_HOUR: i64 = 30;

const COLS: &str = "id, owner, channel_id, thread_id, text, run_at, schedule, status, \
     last_run_at, last_error, created_at, updated_at, created_by, updated_by, via_agent, text_agent, last_due_at";

fn row_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let thread_id: i64 = r.get(3)?;
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "owner": r.get::<_, String>(1)?,
        "channel_id": r.get::<_, String>(2)?,
        "thread_id": if thread_id == 0 { Value::Null } else { json!(thread_id) },
        "text": r.get::<_, String>(4)?,
        "run_at": r.get::<_, f64>(5)?,
        "schedule": serde_json::from_str::<Value>(&r.get::<_, String>(6)?).unwrap_or(Value::Null),
        "status": r.get::<_, String>(7)?,
        "last_run_at": r.get::<_, Option<f64>>(8)?,
        "last_error": r.get::<_, Option<String>>(9)?,
        "created_at": r.get::<_, f64>(10)?,
        "updated_at": r.get::<_, f64>(11)?,
        "created_by": r.get::<_, String>(12)?,
        "updated_by": r.get::<_, String>(13)?,
        "via_agent": r.get::<_, Option<String>>(14)?,
        "text_agent": r.get::<_, Option<String>>(15)?,
        "last_due_at": r.get::<_, Option<f64>>(16)?,
    }))
}

/// Fields a schedule update may carry; `None` leaves a field alone.
/// `schedule` must already be validated (see [`Spec::parse`]).
/// Finished schedules stay in the lists this long, then drop off (the
/// rows are kept; only listing hides them).
pub(crate) const DONE_LISTED_SECS: f64 = 7.0 * 86_400.0;

#[derive(Default, Debug, Clone)]
pub struct ScheduleChange {
    pub text: Option<String>,
    pub run_at: Option<f64>,
    pub schedule: Option<Value>,
    pub status: Option<String>,
    pub clear_error: bool,
}

impl ScheduleChange {
    /// Nothing to write (e.g. resuming a schedule that is already active).
    pub fn is_empty(&self) -> bool {
        self.text.is_none() && self.run_at.is_none() && self.schedule.is_none() && self.status.is_none()
    }
}

/// Why [`Store::update_schedule_if`] wrote nothing.
#[derive(Debug, PartialEq, Eq)]
pub enum UpdateRefused {
    Missing,
    /// The row moved on (a tick fired it, another edit landed) since the
    /// caller read it; the planned change was computed from stale state.
    Changed,
    /// Reactivating would exceed the owner's live-schedule cap.
    Cap,
    /// Too many schedules created for this owner in the last hour.
    Rate,
}

impl UpdateRefused {
    pub fn message(&self, owner: &str) -> String {
        match self {
            UpdateRefused::Missing => "unknown schedule".into(),
            UpdateRefused::Changed => "schedule changed, try again".into(),
            UpdateRefused::Cap => format!("{owner} already has {MAX_LIVE_PER_OWNER} live schedules"),
            UpdateRefused::Rate => format!(
                "{MAX_CREATES_PER_HOUR} schedules were already created for {owner} in the last hour; try again later"
            ),
        }
    }
}

/// What [`Store::record_fire`] did.
#[derive(Debug)]
pub enum Fire {
    /// Posted: `(message, schedule after the advance)`. The schedule is
    /// `None` when it was deleted concurrently (a cascade) after the commit:
    /// the message is stored either way, so it must still be delivered.
    Posted(Value, Option<Value>),
    /// The slot had already posted; the schedule was advanced with an error.
    AlreadyFired(Value),
    /// The schedule is gone, not active, or no longer due at that time.
    NotDue,
}

impl Fire {
    pub fn posted(self) -> Option<(Value, Value)> {
        match self {
            Fire::Posted(m, Some(s)) => Some((m, s)),
            _ => None,
        }
    }
}

/// Write a change in one statement so it lands whole: a new spec never sits
/// beside the old run_at. Returns rows changed. `via_agent` records the last
/// agent that acted on it: a person pausing or retiming keeps that
/// provenance ("via claude") rather than wiping it.
fn apply_change(
    conn: &rusqlite::Connection,
    id: &str,
    change: &ScheduleChange,
    actor: &str,
    via_agent: Option<&str>,
) -> usize {
    conn.execute(
        "UPDATE schedules SET text = COALESCE(?2, text), run_at = COALESCE(?3, run_at), \
         schedule = COALESCE(?4, schedule), status = COALESCE(?5, status), \
         last_error = CASE WHEN ?6 THEN NULL ELSE last_error END, \
         updated_at = ?7, updated_by = ?8, via_agent = COALESCE(?9, via_agent), \
         text_agent = CASE WHEN ?2 IS NOT NULL THEN ?9 ELSE text_agent END WHERE id = ?1",
        params![
            id,
            change.text,
            change.run_at,
            change.schedule.as_ref().map(Value::to_string),
            change.status,
            change.clear_error,
            now(),
            actor,
            via_agent
        ],
    )
    .unwrap()
}

/// Move a schedule past a fired slot: to its next due time, or `done`.
fn advance(
    tx: &rusqlite::Transaction, id: &str, next: Option<f64>, now_s: f64, error: Option<&str>,
    ran: Option<f64>,
) {
    // `ran` is the due slot that just posted: last_run_at records when it
    // actually went out, last_due_at which slot it was.
    let last_run = ran.map(|_| now_s);
    match next {
        Some(next_run) => tx.execute(
            "UPDATE schedules SET run_at = ?2, last_run_at = COALESCE(?3, last_run_at), last_error = ?4, \
             updated_at = ?5, last_due_at = COALESCE(?6, last_due_at) WHERE id = ?1",
            params![id, next_run, last_run, error, now_s, ran],
        ),
        None => tx.execute(
            "UPDATE schedules SET status = 'done', last_run_at = COALESCE(?2, last_run_at), last_error = ?3, \
             updated_at = ?4, last_due_at = COALESCE(?5, last_due_at) WHERE id = ?1",
            params![id, last_run, error, now_s, ran],
        ),
    }
    .unwrap();
}

/// Live (active or paused) schedules an owner holds. Run inside the caller's
/// transaction so the cap check and the write that relies on it agree.
fn live_count(conn: &rusqlite::Connection, owner: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM schedules WHERE owner = ?1 AND status IN ('active', 'paused')",
        params![owner],
        |r| r.get(0),
    )
    .unwrap()
}

fn at_live_cap(conn: &rusqlite::Connection, owner: &str) -> bool {
    live_count(conn, owner) >= MAX_LIVE_PER_OWNER
}

/// Schedules created *or brought back to life* for `owner` in the last hour.
/// Reviving a finished one-off is as good as creating one, so both count.
fn at_hourly_limit(conn: &rusqlite::Connection, owner: &str, now_s: f64) -> bool {
    let since = now_s - 3600.0;
    let recent: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM schedules WHERE owner = ?1 AND created_at >= ?2) + \
                    (SELECT COUNT(*) FROM schedule_revivals WHERE owner = ?1 AND at >= ?2)",
            params![owner, since],
            |r| r.get(0),
        )
        .unwrap();
    recent >= MAX_CREATES_PER_HOUR
}

#[allow(clippy::too_many_arguments)]
fn insert_schedule(
    conn: &rusqlite::Connection,
    id: &str,
    owner: &str,
    channel_id: &str,
    thread_id: Option<i64>,
    text: &str,
    run_at: f64,
    schedule: &Value,
    actor: &str,
    via_agent: Option<&str>,
) {
    let ts = now();
    conn.execute(
        "INSERT INTO schedules (id, owner, channel_id, thread_id, text, run_at, schedule, \
         status, created_at, updated_at, created_by, updated_by, via_agent, text_agent) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8, ?9, ?9, ?10, ?10)",
        params![id, owner, channel_id, thread_id.unwrap_or(0), text, run_at, schedule.to_string(),
            ts, actor, via_agent],
    )
    .unwrap();
}

impl Store {
    /// Test-only: uncapped insert. Production creates go through
    /// create_schedule_capped (live cap + hourly limit).
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_schedule(
        &self,
        owner: &str,
        channel_id: &str,
        thread_id: Option<i64>,
        text: &str,
        run_at: f64,
        schedule: &Value,
        actor: &str,
        via_agent: Option<&str>,
    ) -> Value {
        let id = new_token();
        {
            let conn = self.conn.lock().unwrap();
            insert_schedule(&conn, &id, owner, channel_id, thread_id, text, run_at, schedule, actor, via_agent);
        }
        self.schedule(&id).expect("schedule just inserted")
    }

    pub fn schedule(&self, id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {COLS} FROM schedules WHERE id = ?1"), params![id], row_json)
            .optional()
            .unwrap()
    }

    /// Test-only: apply a change unconditionally. Production writes go
    /// through update_schedule_if (stale-row check, cap, hourly limit).
    #[cfg(test)]
    pub fn update_schedule(
        &self,
        id: &str,
        change: &ScheduleChange,
        actor: &str,
        via_agent: Option<&str>,
    ) -> Option<Value> {
        let changed = {
            let conn = self.conn.lock().unwrap();
            apply_change(&conn, id, change, actor, via_agent)
        };
        if changed == 0 {
            return None;
        }
        self.schedule(id)
    }

    /// Apply a change planned from `expected` (the row as the caller read
    /// it) only if the row is still exactly that version — same status, due
    /// time and `updated_at` (any write bumps it, so a spec or text edit that
    /// kept the due time still counts as a change). The live-cap and hourly
    /// checks for a schedule coming back to life run in the same transaction,
    /// so a concurrent tick, edit or create can't be overwritten or slip past
    /// either limit.
    pub fn update_schedule_if(
        &self,
        id: &str,
        expected: &Value,
        change: &ScheduleChange,
        actor: &str,
        via_agent: Option<&str>,
    ) -> Result<Value, UpdateRefused> {
        let expected_status = expected["status"].as_str().unwrap_or_default();
        let expected_run_at = expected["run_at"].as_f64().unwrap_or(f64::NAN);
        let expected_updated = expected["updated_at"].as_f64();
        let revives = expected_status == "done" && matches!(change.status.as_deref(), Some("active" | "paused"));
        {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            let row: Option<(String, f64, String, f64)> = tx
                .query_row(
                    "SELECT status, run_at, owner, updated_at FROM schedules WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .unwrap();
            let Some((status, run_at, owner, updated_at)) = row else { return Err(UpdateRefused::Missing) };
            if status != expected_status
                || run_at != expected_run_at
                || expected_updated.is_some_and(|u| u != updated_at)
            {
                return Err(UpdateRefused::Changed);
            }
            if revives {
                if at_live_cap(&tx, &owner) {
                    return Err(UpdateRefused::Cap);
                }
                let now_s = now();
                if at_hourly_limit(&tx, &owner, now_s) {
                    return Err(UpdateRefused::Rate);
                }
                tx.execute(
                    "INSERT INTO schedule_revivals (owner, schedule_id, at) VALUES (?1, ?2, ?3)",
                    params![owner, id, now_s],
                )
                .unwrap();
            }
            apply_change(&tx, id, change, actor, via_agent);
            tx.commit().unwrap();
        }
        self.schedule(id).ok_or(UpdateRefused::Missing)
    }

    /// Cheap early refusal for a create, so a request that would hit the cap
    /// or the hourly limit is turned away before any costly spec validation.
    /// Advisory only: [`Store::create_schedule_capped`] re-checks in its
    /// transaction.
    pub fn create_refusal(&self, owner: &str) -> Option<UpdateRefused> {
        let conn = self.conn.lock().unwrap();
        if at_live_cap(&conn, owner) {
            return Some(UpdateRefused::Cap);
        }
        at_hourly_limit(&conn, owner, now()).then_some(UpdateRefused::Rate)
    }

    /// Create unless the owner is at the live cap — count and insert in one
    /// transaction so two concurrent creates can't both squeeze past it.
    #[allow(clippy::too_many_arguments)]
    pub fn create_schedule_capped(
        &self,
        owner: &str,
        channel_id: &str,
        thread_id: Option<i64>,
        text: &str,
        run_at: f64,
        schedule: &Value,
        actor: &str,
        via_agent: Option<&str>,
    ) -> Result<Value, UpdateRefused> {
        let id = new_token();
        {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            if at_live_cap(&tx, owner) {
                return Err(UpdateRefused::Cap);
            }
            if at_hourly_limit(&tx, owner, now()) {
                return Err(UpdateRefused::Rate);
            }
            insert_schedule(&tx, &id, owner, channel_id, thread_id, text, run_at, schedule, actor, via_agent);
            tx.commit().unwrap();
        }
        Ok(self.schedule(&id).expect("schedule just inserted"))
    }

    /// The tick found the owner can no longer post there: park it with the
    /// reason instead of retrying every tick, so the owner sees why it stopped.
    pub fn pause_schedule_with_error(&self, id: &str, error: &str) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE schedules SET status = 'paused', last_error = ?2, updated_at = ?3 \
                 WHERE id = ?1 AND status = 'active'",
                params![id, error, now()],
            )
            .unwrap();
        }
        self.schedule(id)
    }

    /// Schedules shown in a channel's list (thread ones included unless a
    /// thread filter is given). Cancelled rows are history, not shown, and
    /// finished ones drop off after DONE_LISTED_SECS.
    pub fn list_schedules_for_channel(&self, channel_id: &str, thread_id: Option<i64>) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM schedules WHERE channel_id = ?1 AND status != 'cancelled' \
                 AND (status != 'done' OR updated_at >= ?3) \
                 AND (?2 IS NULL OR thread_id = ?2) ORDER BY run_at, id"
            ))
            .unwrap();
        stmt.query_map(params![channel_id, thread_id, now() - DONE_LISTED_SECS], row_json)
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    /// Every non-cancelled schedule in channels the user can access. Admins
    /// see all regular channels; agent DMs stay owner-only even for admins,
    /// matching the DM privacy rule everywhere else. Unlike the inbox's
    /// sidebar list, hidden channels are included: hiding is presentation,
    /// and a schedule there still posts. The user's own schedules are always
    /// included, even where they've lost access, so they can stop them.
    pub fn list_visible_schedules(&self, username: &str, instance_admin: bool) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let cols: String = COLS.split(", ").map(|c| format!("s.{c}")).collect::<Vec<_>>().join(", ");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {cols} FROM schedules s JOIN channels c ON c.id = s.channel_id \
                 LEFT JOIN groups g ON g.id = c.group_id \
                 WHERE s.status != 'cancelled' AND (s.status != 'done' OR s.updated_at >= ?3) AND ( \
                   s.owner = ?1 OR \
                   (c.kind = 'agent_dm' AND c.dm_user_id = ?1) OR \
                   (c.kind != 'agent_dm' AND g.id IS NOT NULL AND (?2 = 1 OR g.is_public = 1 OR EXISTS ( \
                     SELECT 1 FROM memberships m WHERE m.group_id = g.id AND m.member_type = 'user' \
                       AND m.member_id = ?1 AND (m.channel_id = '' OR m.channel_id = c.id))))) \
                 ORDER BY s.run_at, s.id"
            ))
            .unwrap();
        stmt.query_map(params![username, instance_admin as i64, now() - DONE_LISTED_SECS], row_json)
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    /// One owner's schedules (for an agent acting on their behalf).
    pub fn list_owner_schedules(&self, owner: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM schedules WHERE owner = ?1 AND status != 'cancelled' \
                 AND (status != 'done' OR updated_at >= ?2) ORDER BY run_at, id"
            ))
            .unwrap();
        stmt.query_map(params![owner, now() - DONE_LISTED_SECS], row_json).unwrap().filter_map(Result::ok).collect()
    }

    #[cfg(test)]
    pub fn count_live_schedules(&self, owner: &str) -> i64 {
        live_count(&self.conn.lock().unwrap(), owner)
    }

    pub fn due_schedules(&self, now_s: f64) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM schedules WHERE status = 'active' AND run_at <= ?1 ORDER BY run_at, id"
            ))
            .unwrap();
        stmt.query_map(params![now_s], row_json).unwrap().filter_map(Result::ok).collect()
    }

    /// Commit one fire atomically: the owner-authored message, the fire record
    /// and the schedule's advance. The UNIQUE(schedule_id, due_at) key is what
    /// makes a repeated or concurrent tick harmless.
    pub fn record_fire(
        &self,
        schedule_id: &str,
        due_at: f64,
        author_name: &str,
        now_s: f64,
    ) -> Fire {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().unwrap();
        let row: Option<(String, String, i64, String, String, Option<String>)> = tx
            .query_row(
                "SELECT owner, channel_id, thread_id, text, schedule, text_agent FROM schedules \
                 WHERE id = ?1 AND status = 'active' AND run_at = ?2",
                params![schedule_id, due_at],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
            .unwrap();
        let Some((owner, channel_id, thread_id, text, spec_json, text_agent)) = row else { return Fire::NotDue };
        // A spec that no longer parses (hand-edited row) fires this once and
        // finishes rather than wedging the tick on every pass.
        let next = serde_json::from_str::<Value>(&spec_json)
            .ok()
            .and_then(|v| Spec::from_stored(&v).ok())
            .and_then(|spec| spec.next_after_fire(due_at, now_s));
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO schedule_fires (schedule_id, due_at, delivered, created_at, late_by) \
                 VALUES (?1, ?2, 0, ?3, ?4)",
                params![schedule_id, due_at, now_s, (now_s - due_at).max(0.0)],
            )
            .unwrap();
        if inserted == 0 {
            // This exact slot already posted (a re-arm landed on a past due
            // time). Advance it as if it had fired, with a visible reason,
            // instead of leaving it active in the past where every tick would
            // skip it silently.
            let error = format!("already fired at {}", fmt_utc(due_at));
            advance(&tx, schedule_id, next, now_s, Some(&error), None);
            tx.commit().unwrap();
            drop(conn);
            return match self.schedule(schedule_id) {
                Some(schedule) => Fire::AlreadyFired(schedule),
                None => Fire::NotDue,
            };
        }
        // Who wrote the words: the post goes out as the owner, but other
        // agents must be able to tell an agent drafted it (see hub fan-out).
        let writer_name: Option<String> = text_agent.as_deref().and_then(|a| {
            tx.query_row("SELECT name FROM agents WHERE id = ?1", params![a], |r| r.get(0)).optional().unwrap()
        });
        let mut meta = json!({"scheduled": true, "schedule_id": schedule_id});
        if let Some(writer) = &text_agent {
            meta["written_by_agent"] = json!(writer);
            meta["written_by_agent_name"] = json!(writer_name.unwrap_or_else(|| writer.clone()));
        }
        let seq: i64 = tx
            .query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM messages", [], |r| r.get(0))
            .unwrap();
        let thread = (thread_id != 0).then_some(thread_id);
        tx.execute(
            "INSERT INTO messages (seq, channel_id, thread_id, author_type, author_id, author_name, text, ts, meta) \
             VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6, ?7, ?8)",
            params![seq, channel_id, thread, owner, author_name, text, now_s, meta.to_string()],
        )
        .unwrap();
        let message_id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE schedule_fires SET message_id = ?3 WHERE schedule_id = ?1 AND due_at = ?2",
            params![schedule_id, due_at, message_id],
        )
        .unwrap();
        advance(&tx, schedule_id, next, now_s, None, Some(due_at));
        tx.commit().unwrap();
        drop(conn);
        let message = json!({
            "id": message_id,
            "seq": seq,
            "channel_id": channel_id,
            "thread_id": thread,
            "author_type": "user",
            "author_id": owner,
            "author_name": author_name,
            "text": text,
            "ts": now_s,
            "meta": meta,
            "attachments": [],
        });
        Fire::Posted(message, self.schedule(schedule_id))
    }

    pub fn mark_fire_delivered(&self, schedule_id: &str, due_at: f64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE schedule_fires SET delivered = 1 WHERE schedule_id = ?1 AND due_at = ?2",
            params![schedule_id, due_at],
        )
        .unwrap();
    }

    /// Fires committed since `since` whose side effects never ran (the
    /// process died between commit and delivery): `(schedule_id, due_at,
    /// message_id)`.
    pub fn undelivered_fires(&self, since: f64) -> Vec<(String, f64, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT schedule_id, due_at, message_id FROM schedule_fires \
                 WHERE delivered = 0 AND message_id IS NOT NULL AND created_at >= ?1 ORDER BY created_at",
            )
            .unwrap();
        stmt.query_map(params![since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    /// Undelivered fires older than the redelivery window are given up on:
    /// marked delivered so prune can drop them instead of keeping them
    /// forever. Returns how many were skipped.
    pub fn skip_stale_undelivered_fires(&self, before: f64) -> usize {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE schedule_fires SET delivered = 1 WHERE delivered = 0 AND created_at < ?1",
            params![before],
        )
        .unwrap()
    }

    /// Fire records exist for idempotency and crash recovery; once delivered
    /// and old they serve neither.
    pub fn prune_schedule_fires(&self, older_than: f64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM schedule_fires WHERE delivered = 1 AND created_at < ?1",
            params![older_than],
        )
        .unwrap();
        // Revivals only matter for the rolling hour; keep a day for debugging.
        conn.execute(
            "DELETE FROM schedule_revivals WHERE at < ?1",
            params![now() - 86_400.0],
        )
        .unwrap();
    }

    /// Whether `owner` may post in the channel right now — the same gates as
    /// `require_channel_postable` for a live request, evaluated for a person
    /// who isn't present (the tick and agent grants act for them).
    pub fn schedule_owner_can_post(&self, owner: &str, channel_id: &str) -> Result<Value, String> {
        let user = self.user(owner).ok_or("schedule owner no longer exists")?;
        if user["disabled"].as_bool().unwrap_or(false) {
            return Err("schedule owner is disabled".into());
        }
        let channel = self.channel(channel_id).ok_or("channel no longer exists")?;
        if channel["kind"] == "agent_dm" {
            if channel["dm_user_id"].as_str() != Some(owner) {
                return Err("this direct message is private".into());
            }
            let agent_id = channel["dm_agent_id"].as_str().unwrap_or_default();
            if !self.user_can_start_agent_dm(owner, agent_id) {
                return Err("agent DM access has been revoked".into());
            }
            if self.agent(agent_id).is_none() {
                return Err("this agent is no longer available".into());
            }
            return Ok(channel);
        }
        if user["instance_role"] != "admin" && !self.user_can_see_channel(owner, channel_id) {
            return Err("schedule owner is no longer a member of this channel".into());
        }
        Ok(channel)
    }
}

/// Deletion hooks share this so every path that removes a scope also drops
/// its schedules (a schedule into a deleted channel would only ever error)
/// and their fire records. Scoped to the schedules being removed — the
/// (schedule_id, due_at) index serves it — instead of scanning every fire
/// record on each message delete.
pub(super) fn delete_schedules_where<P: rusqlite::Params + Clone>(
    conn: &rusqlite::Connection,
    predicate: &str,
    params: P,
) -> Vec<(String, i64, String)> {
    // Live rows only matter to open lists; cancelled ones aren't shown.
    let affected: Vec<(String, i64, String)> = conn
        .prepare(&format!(
            "SELECT channel_id, thread_id, owner FROM schedules WHERE ({predicate}) AND status != 'cancelled'"
        ))
        .unwrap()
        .query_map(params.clone(), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    conn.execute(
        &format!("DELETE FROM schedule_fires WHERE schedule_id IN (SELECT id FROM schedules WHERE {predicate})"),
        params.clone(),
    )
    .unwrap();
    conn.execute(&format!("DELETE FROM schedules WHERE {predicate}"), params).unwrap();
    affected
}

impl Store {
    pub(super) fn note_schedule_cascade(&self, affected: Vec<(String, i64, String)>) {
        if !affected.is_empty() {
            self.schedule_cascades.lock().unwrap().extend(affected);
        }
    }

    /// Drain schedules removed by a cascade delete since the last call:
    /// `(channel_id, thread_id or None, owner)`, de-duplicated.
    pub fn take_schedule_cascades(&self) -> Vec<(String, Option<i64>, String)> {
        let mut raw = std::mem::take(&mut *self.schedule_cascades.lock().unwrap());
        raw.sort();
        raw.dedup();
        raw.into_iter().map(|(c, t, o)| (c, (t != 0).then_some(t), o)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup() -> (Store, String) {
        let store = Store::open_in_memory().unwrap();
        store.create_user("ana", "Ana", None, "member").unwrap();
        let g = store.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        store.add_member(gid, "user", "ana", "member", None);
        let c = store.create_channel(gid, "main", "");
        (store, c["id"].as_str().unwrap().to_string())
    }

    fn interval(store: &Store, cid: &str, thread: Option<i64>, run_at: f64) -> Value {
        store.create_schedule("ana", cid, thread, "@claude LOOP x", run_at,
            &json!({"kind": "interval", "seconds": 3600}), "ana", Some("claude"))
    }

    #[test]
    fn record_fire_posts_once_as_owner_and_advances_without_bursts() {
        let (store, cid) = setup();
        let s = interval(&store, &cid, None, 1000.0);
        let id = s["id"].as_str().unwrap();
        assert_eq!(store.due_schedules(999.0).len(), 0);
        assert_eq!(store.due_schedules(1000.0).len(), 1);
        // Ten hours late (downtime): one post, next slot keeps the phase.
        let now_s = 1000.0 + 36_000.0 + 5.0;
        let (msg, after) = store.record_fire(id, 1000.0, "Ana", now_s).posted().unwrap();
        assert_eq!(msg["author_type"], "user");
        assert_eq!(msg["author_id"], "ana");
        assert_eq!(msg["meta"]["scheduled"], true);
        assert_eq!(msg["meta"]["schedule_id"], id);
        assert_eq!(store.message(msg["id"].as_i64().unwrap()).unwrap()["meta"]["scheduled"], true);
        assert_eq!(after["run_at"], 1000.0 + 39_600.0);
        assert_eq!(after["status"], "active");
        // The same fire again (repeated tick / second claimer) is a no-op.
        assert!(matches!(store.record_fire(id, 1000.0, "Ana", now_s), Fire::NotDue));
        assert_eq!(store.undelivered_fires(0.0).len(), 1);
        store.mark_fire_delivered(id, 1000.0);
        assert!(store.undelivered_fires(0.0).is_empty());
    }

    #[test]
    fn one_off_finishes_and_cron_round_trips() {
        let (store, cid) = setup();
        let once = store.create_schedule("ana", &cid, None, "hi", 50.0,
            &json!({"kind": "once", "at": 50.0}), "ana", None);
        let (_, after) = store.record_fire(once["id"].as_str().unwrap(), 50.0, "Ana", 51.0).posted().unwrap();
        assert_eq!(after["status"], "done");
        assert_eq!(after["last_run_at"], 51.0);
        let seven = 1_792_479_600.0; // 2026-10-20 07:00 UTC
        let cron = store.create_schedule("ana", &cid, None, "daily", seven,
            &json!({"kind": "cron", "expr": "0 7 * * *"}), "ana", None);
        assert_eq!(cron["schedule"], json!({"kind": "cron", "expr": "0 7 * * *"}));
        let (_, after) = store.record_fire(cron["id"].as_str().unwrap(), seven, "Ana", seven + 2.0 * 86_400.0).posted().unwrap();
        assert_eq!(after["run_at"], seven + 3.0 * 86_400.0);
    }

    #[test]
    fn finished_schedules_drop_off_the_lists_after_a_week() {
        let (store, cid) = setup();
        let t = now();
        let recent = store.create_schedule("ana", &cid, None, "recent", t - 10.0,
            &json!({"kind": "once", "at": t - 10.0}), "ana", None);
        store.record_fire(recent["id"].as_str().unwrap(), t - 10.0, "Ana", t).posted().unwrap();
        let old_at = t - DONE_LISTED_SECS - 60.0;
        let old = store.create_schedule("ana", &cid, None, "old", old_at,
            &json!({"kind": "once", "at": old_at}), "ana", None);
        store.record_fire(old["id"].as_str().unwrap(), old_at, "Ana", old_at + 1.0).posted().unwrap();
        let texts = |items: Vec<Value>| items.iter().map(|s| s["text"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(texts(store.list_schedules_for_channel(&cid, None)), ["recent"]);
        assert_eq!(texts(store.list_visible_schedules("ana", false)), ["recent"]);
        assert_eq!(texts(store.list_owner_schedules("ana")), ["recent"]);
        // The row itself is kept; only the lists hide it.
        assert_eq!(store.schedule(old["id"].as_str().unwrap()).unwrap()["status"], "done");
    }

    #[test]
    fn schedules_are_removed_with_their_scope() {
        let (store, cid) = setup();
        let root = store.add_message_with_meta(&cid, "root", "user", "ana", Some("Ana"), None, &[], None);
        let tid = root["id"].as_i64().unwrap();
        let top = interval(&store, &cid, None, 10.0);
        let in_thread = interval(&store, &cid, Some(tid), 10.0);
        store.record_fire(in_thread["id"].as_str().unwrap(), 10.0, "Ana", 11.0).posted().unwrap();
        // Clearing the chat drops thread schedules (their threads are gone) only.
        store.clear_channel_messages(&cid);
        assert!(store.schedule(in_thread["id"].as_str().unwrap()).is_none());
        assert!(store.schedule(top["id"].as_str().unwrap()).is_some());
        assert!(store.undelivered_fires(0.0).is_empty(), "orphan fires go too");
        // Deleting a thread root drops that thread's schedules.
        let root2 = store.add_message_with_meta(&cid, "root2", "user", "ana", Some("Ana"), None, &[], None);
        let t2 = interval(&store, &cid, root2["id"].as_i64(), 10.0);
        store.delete_message(root2["id"].as_i64().unwrap());
        assert!(store.schedule(t2["id"].as_str().unwrap()).is_none());
        // Deleting the user drops everything they own.
        store.delete_user_data("ana");
        assert!(store.schedule(top["id"].as_str().unwrap()).is_none());
        // Channel and group deletion.
        store.create_user("bob", "Bob", None, "member").unwrap();
        let s = store.create_schedule("bob", &cid, None, "x", 10.0, &json!({"kind":"once","at":10.0}), "bob", None);
        store.delete_channel(&cid);
        assert!(store.schedule(s["id"].as_str().unwrap()).is_none());
        let g = store.create_group("G2", "", None);
        let gid = g["id"].as_str().unwrap();
        let c2 = store.create_channel(gid, "c", "");
        let s2 = store.create_schedule("bob", c2["id"].as_str().unwrap(), None, "x", 10.0,
            &json!({"kind":"once","at":10.0}), "bob", None);
        store.delete_group(gid);
        assert!(store.schedule(s2["id"].as_str().unwrap()).is_none());
    }

    #[test]
    fn visibility_lists_follow_channel_access_and_dm_privacy() {
        let (store, cid) = setup();
        store.create_user("bob", "Bob", None, "member").unwrap();
        store.create_user("root", "Root", None, "admin").unwrap();
        interval(&store, &cid, None, 10.0);
        store.upsert_agent("claude", "Claude", "test", false, false, 0);
        store.set_agent_dm_policy("claude", true, &[]);
        let dm = store.open_agent_dm("ana", "claude", "Claude");
        interval(&store, dm["id"].as_str().unwrap(), None, 10.0);
        assert_eq!(store.list_visible_schedules("ana", false).len(), 2);
        assert_eq!(store.list_visible_schedules("bob", false).len(), 0, "not a member");
        // Admin: every regular channel, but not someone else's DM.
        let admin = store.list_visible_schedules("root", true);
        assert_eq!(admin.len(), 1);
        assert_eq!(admin[0]["channel_id"], cid.as_str());
        // Cancelled rows are history, not listed.
        let id = admin[0]["id"].as_str().unwrap().to_string();
        store.update_schedule(&id, &ScheduleChange { status: Some("cancelled".into()), ..Default::default() }, "ana", None);
        assert!(store.list_schedules_for_channel(&cid, None).is_empty());
    }

    #[test]
    fn owner_post_check_mirrors_live_posting_rules() {
        let (store, cid) = setup();
        assert!(store.schedule_owner_can_post("ana", &cid).is_ok());
        assert!(store.schedule_owner_can_post("ghost", &cid).unwrap_err().contains("no longer exists"));
        store.create_user("bob", "Bob", None, "member").unwrap();
        assert!(store.schedule_owner_can_post("bob", &cid).unwrap_err().contains("member"));
        store.set_user_disabled("ana", true);
        assert!(store.schedule_owner_can_post("ana", &cid).unwrap_err().contains("disabled"));
    }

    #[test]
    fn deleting_a_scope_drops_only_its_schedules_fire_records() {
        let (store, cid) = setup();
        let gid = store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        let other = store.create_channel(&gid, "other", "")["id"].as_str().unwrap().to_string();
        let gone = interval(&store, &cid, None, 1000.0);
        let kept = interval(&store, &other, None, 1000.0);
        store.record_fire(gone["id"].as_str().unwrap(), 1000.0, "Ana", 1001.0).posted().unwrap();
        store.record_fire(kept["id"].as_str().unwrap(), 1000.0, "Ana", 1001.0).posted().unwrap();
        let fires = |store: &Store, id: &Value| -> i64 {
            store.conn.lock().unwrap().query_row(
                "SELECT COUNT(*) FROM schedule_fires WHERE schedule_id = ?1",
                params![id.as_str().unwrap()], |r| r.get(0)).unwrap()
        };
        assert_eq!(fires(&store, &gone["id"]), 1);
        assert!(store.delete_channel(&cid));
        assert!(store.schedule(gone["id"].as_str().unwrap()).is_none());
        assert_eq!(fires(&store, &gone["id"]), 0);
        assert!(store.schedule(kept["id"].as_str().unwrap()).is_some());
        assert_eq!(fires(&store, &kept["id"]), 1, "other channels' fire records stay");
    }

    #[test]
    fn rearming_onto_an_already_fired_slot_advances_with_an_error() {
        let (store, cid) = setup();
        let once = store.create_schedule("ana", &cid, None, "hi", 50.0,
            &json!({"kind": "once", "at": 50.0}), "ana", None);
        let id = once["id"].as_str().unwrap();
        store.record_fire(id, 50.0, "Ana", 51.0).posted().unwrap();
        // Re-armed to the exact due time that already posted.
        store.update_schedule(id, &ScheduleChange { run_at: Some(50.0), status: Some("active".into()),
            ..Default::default() }, "ana", None).unwrap();
        let Fire::AlreadyFired(after) = store.record_fire(id, 50.0, "Ana", 60.0) else { panic!("expected AlreadyFired") };
        assert_eq!(after["status"], "done", "not left active in the past");
        assert!(after["last_error"].as_str().unwrap().contains("already fired"));
        assert_eq!(after["last_run_at"], 51.0, "no new run recorded");
        assert!(store.due_schedules(100.0).is_empty());
        // A recurring one moves to its next slot instead.
        let iv = interval(&store, &cid, None, 1000.0);
        let iid = iv["id"].as_str().unwrap();
        store.record_fire(iid, 1000.0, "Ana", 1001.0).posted().unwrap();
        store.update_schedule(iid, &ScheduleChange { run_at: Some(1000.0), ..Default::default() }, "ana", None);
        let Fire::AlreadyFired(after) = store.record_fire(iid, 1000.0, "Ana", 1002.0) else { panic!() };
        assert_eq!(after["status"], "active");
        assert_eq!(after["run_at"], 4600.0);
    }

    #[test]
    fn update_applies_every_field_in_one_change() {
        let (store, cid) = setup();
        let s = interval(&store, &cid, None, 1000.0);
        let id = s["id"].as_str().unwrap();
        store.conn.lock().unwrap().execute("UPDATE schedules SET last_error = 'x' WHERE id = ?1", params![id]).unwrap();
        let after = store.update_schedule(id, &ScheduleChange {
            text: Some("new".into()), run_at: Some(2000.0),
            schedule: Some(json!({"kind": "interval", "seconds": 600})),
            status: Some("paused".into()), clear_error: true }, "bob", Some("codex")).unwrap();
        assert_eq!(after["text"], "new");
        assert_eq!(after["run_at"], 2000.0);
        assert_eq!(after["schedule"]["seconds"], 600);
        assert_eq!(after["status"], "paused");
        assert!(after["last_error"].is_null());
        assert_eq!(after["updated_by"], "bob");
        assert_eq!(after["via_agent"], "codex");
        // Untouched fields stay; the error survives without clear_error.
        store.conn.lock().unwrap().execute("UPDATE schedules SET last_error = 'y' WHERE id = ?1", params![id]).unwrap();
        let after = store.update_schedule(id, &ScheduleChange { status: Some("active".into()), ..Default::default() }, "ana", None).unwrap();
        assert_eq!(after["text"], "new");
        assert_eq!(after["last_error"], "y");
        assert!(store.update_schedule("nope", &ScheduleChange::default(), "ana", None).is_none());
    }

    #[test]
    fn a_change_planned_from_stale_state_is_refused() {
        let (store, cid) = setup();
        let at = now() + 600.0;
        let s = store.create_schedule("ana", &cid, None, "x", at, &json!({"kind": "once", "at": at}), "ana", None);
        let id = s["id"].as_str().unwrap();
        // Something else (a tick, another edit) moves it after we read it.
        let moved = ScheduleChange { run_at: Some(at + 60.0), ..Default::default() };
        store.update_schedule(id, &moved, "ana", None).unwrap();
        let pause = ScheduleChange { status: Some("paused".into()), ..Default::default() };
        assert_eq!(store.update_schedule_if(id, &s, &pause, "cat", None).unwrap_err(), UpdateRefused::Changed);
        let fresh = store.schedule(id).unwrap();
        assert_eq!(store.update_schedule_if(id, &fresh, &pause, "cat", None).unwrap()["status"], "paused");
        assert_eq!(store.update_schedule_if("nope", &fresh, &pause, "cat", None).unwrap_err(), UpdateRefused::Missing);
    }

    #[test]
    fn the_live_cap_holds_inside_the_write() {
        let (store, cid) = setup();
        let at = now() + 600.0;
        let spec = json!({"kind": "once", "at": at});
        // Fill up uncapped (the hourly create limit would trip first otherwise).
        for _ in 0..MAX_LIVE_PER_OWNER {
            store.create_schedule("ana", &cid, None, "x", at, &spec, "ana", None);
        }
        assert_eq!(store.create_schedule_capped("ana", &cid, None, "x", at, &spec, "ana", None).unwrap_err(),
            UpdateRefused::Cap);
        // A finished one-off coming back counts too.
        let done = store.create_schedule("ana", &cid, None, "old", at, &spec, "ana", None);
        let id = done["id"].as_str().unwrap();
        store.update_schedule(id, &ScheduleChange { status: Some("done".into()), ..Default::default() }, "ana", None);
        let done = store.schedule(id).unwrap();
        let revive = ScheduleChange { status: Some("active".into()), run_at: Some(at), ..Default::default() };
        assert_eq!(store.update_schedule_if(id, &done, &revive, "ana", None).unwrap_err(), UpdateRefused::Cap);
    }

    #[test]
    fn cascade_deletes_report_what_they_removed() {
        let (store, cid) = setup();
        let at = now() + 600.0;
        let spec = json!({"kind": "once", "at": at});
        store.create_schedule("ana", &cid, None, "x", at, &spec, "ana", None);
        let root = store.add_message(&cid, "root", "user", "ana", Some("Ana"), None, &[]);
        let tid = root["id"].as_i64().unwrap();
        store.create_schedule("ana", &cid, Some(tid), "t", at, &spec, "ana", None);
        assert!(store.delete_message(tid));
        assert_eq!(store.take_schedule_cascades(), vec![(cid.clone(), Some(tid), "ana".to_string())]);
        store.delete_channel(&cid);
        assert_eq!(store.take_schedule_cascades(), vec![(cid.clone(), None, "ana".to_string())]);
        assert!(store.take_schedule_cascades().is_empty());
    }
}
