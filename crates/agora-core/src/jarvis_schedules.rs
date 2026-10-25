//! Jarvis and the scheduler: list the user's own schedules, and draft a new
//! schedule or a change to one of them. Nothing is written here — every
//! write is a draft the user confirms (button or spoken yes), then applied
//! through the scheduler's own create / PATCH / cancel paths.
//!
//! Times: the user speaks in local time. The client reports its UTC offset
//! now and the offset changes its zone makes over the coming year, so a
//! one-off local time converts at the offset in force *on that date* (a
//! December 9am said in October is still 9am). A recurring cron rule is
//! stored in UTC and can't follow daylight saving, so only the simple local
//! shape ("09:00 on weekdays") is converted, and the card says it will
//! shift; anything else must be given in UTC or as an every-N interval.

use serde_json::{json, Value};

use crate::jarvis::{ev_card, ev_draft_cancelled, Draft, DraftKind, ToolCtx, DRAFT_TTL};
use crate::schedule_spec::Spec;

/// Most schedules one `list_schedules` call returns.
const MAX_LIST: usize = 20;
/// How many rows the owner list scans (live first), as the agent path does.
const MAX_SCANNED: usize = 1000;
/// Real UTC offsets run from -12:00 to +14:00.
const MAX_OFFSET_MINUTES: i64 = 14 * 60;

/// The client's clock, for converting what the user says.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TzHint {
    /// Minutes east of UTC right now (IST = 330, New York in winter = -300).
    pub offset_minutes: i32,
    /// The zone shifts with daylight saving, so a fixed offset is only
    /// right for part of the year.
    pub has_dst: bool,
    /// The offset changes coming up, as the client's own zone rules say:
    /// (unix seconds it takes effect, minutes east from then), in order.
    pub transitions: Vec<(f64, i32)>,
}

impl TzHint {
    /// A zone that never changes offset.
    pub fn fixed(offset_minutes: i32) -> Self {
        Self { offset_minutes, ..Default::default() }
    }

    /// The offset in force at unix time `t`.
    pub fn offset_at(&self, t: f64) -> i32 {
        self.transitions.iter().take_while(|(at, _)| *at <= t).last().map_or(self.offset_minutes, |(_, o)| *o)
    }

    /// No offset information at all: times read and print as UTC.
    fn is_utc(&self) -> bool {
        self.offset_minutes == 0 && self.transitions.is_empty()
    }

    /// The instant a local wall-clock time (`wall`: its fields read as if
    /// UTC) means, at the offset in force then. A time the clocks skip
    /// (spring forward) moves forward past the gap; a time they repeat (fall
    /// back) takes the first one. Either way the note says so.
    pub fn wall_to_utc(&self, wall: f64) -> (f64, Option<String>) {
        let mut offsets: Vec<i32> = std::iter::once(self.offset_minutes).chain(self.transitions.iter().map(|(_, o)| *o)).collect();
        offsets.sort_unstable();
        offsets.dedup();
        let candidates: Vec<f64> = offsets.iter().map(|o| wall - *o as f64 * 60.0).collect();
        let valid: Vec<f64> = offsets
            .iter()
            .zip(&candidates)
            .filter(|(o, u)| self.offset_at(**u) == **o)
            .map(|(_, u)| *u)
            .collect();
        if let Some(first) = valid.iter().copied().reduce(f64::min) {
            let note = (valid.len() > 1).then(|| "That local time happens twice when the clocks go back; using the first one.".to_string());
            return (first, note);
        }
        let later = candidates.iter().copied().reduce(f64::max).unwrap_or(wall);
        (later, Some(format!("That local time is skipped when the clocks go forward, so it's moved to {}.", local_ts(later, self))))
    }
}

/// A change Jarvis can draft for the person: the body PATCH takes, or
/// cancel (DELETE). Only ever on the person's own schedules.
#[derive(Clone, Debug, PartialEq)]
pub enum OwnChange {
    Patch(Value),
    Cancel,
}

/// What a person can change about a schedule (status, cadence, where it
/// posts, whose it is) — not the bookkeeping a run moves (`run_at`,
/// `updated_at`, a one-off's re-armed time). A change draft is bound to this,
/// so a run firing while the card waits doesn't block "pause it".
pub(crate) fn change_fingerprint(s: &Value) -> String {
    let spec = &s["schedule"];
    json!({
        "status": s["status"], "owner": s["owner"], "channel_id": s["channel_id"], "thread_id": s["thread_id"],
        "kind": spec["kind"], "seconds": spec["seconds"], "expr": spec["expr"],
    })
    .to_string()
}

// ------------------------------------------------------------- local time

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// A time the user gave, as unix seconds: a number (already unix), an ISO
/// time with an offset or `Z` (taken as written), or a local wall time
/// `YYYY-MM-DDTHH:MM[:SS]` (at the client's offset on that date).
/// Calendar fields are range-checked, so "Feb 30" or "25:00" is an error,
/// not a silently rolled-over date.
pub fn parse_when(raw: &Value, tz: &TzHint) -> Result<f64, String> {
    parse_when_noted(raw, tz).map(|(t, _)| t)
}

/// [`parse_when`], plus a note when a local time fell in a clock change.
pub fn parse_when_noted(raw: &Value, tz: &TzHint) -> Result<(f64, Option<String>), String> {
    if let Some(t) = raw.as_f64() {
        return Ok((t, None));
    }
    let s = raw.as_str().map(str::trim).filter(|s| !s.is_empty()).ok_or("give a time")?;
    let bad = || format!("“{s}” isn't a time I can read; use YYYY-MM-DDTHH:MM in the user's local time");
    let (date, rest) = s.split_once(['T', ' ']).ok_or_else(bad)?;
    let mut d = date.split('-');
    let (y, mo, da) = (d.next(), d.next(), d.next());
    let num = |v: Option<&str>| v.and_then(|v| v.parse::<i64>().ok());
    let (Some(y), Some(mo), Some(da)) = (num(y), num(mo), num(da)) else { return Err(bad()) };
    // Split off an explicit offset ("Z", "+05:30", "-0400").
    let (clock, offset) = if let Some(c) = rest.strip_suffix(['Z', 'z']) {
        (c, Some(0))
    } else if let Some(i) = rest.rfind(['+', '-']).filter(|&i| i > 0) {
        let off = rest[i + 1..].replace(':', "");
        let (oh, om) = (off.get(..2).and_then(|v| v.parse::<i64>().ok()), off.get(2..).map_or(Some(0), |v| if v.is_empty() { Some(0) } else { v.parse::<i64>().ok() }));
        let (Some(oh), Some(om)) = (oh, om) else { return Err(bad()) };
        if om >= 60 || oh * 60 + om > MAX_OFFSET_MINUTES {
            return Err(format!("“{s}” has an offset outside -14:00..+14:00"));
        }
        let sign = if rest.as_bytes()[i] == b'-' { -1 } else { 1 };
        (&rest[..i], Some(sign * (oh * 60 + om)))
    } else {
        (rest, None)
    };
    let mut c = clock.split(':');
    let (h, mi, sec) = (num(c.next()), num(c.next()), c.next().map_or(Some(0), |v| v.split('.').next().and_then(|v| v.parse::<i64>().ok())));
    let (Some(h), Some(mi), Some(sec)) = (h, mi, sec) else { return Err(bad()) };
    if !(1..=12).contains(&mo) || da < 1 || da > days_in_month(y, mo) || !(0..24).contains(&h) || !(0..60).contains(&mi) || !(0..60).contains(&sec) {
        return Err(format!("“{s}” isn't a real date and time"));
    }
    let wall = ((days_from_civil(y, mo, da) * 86_400) + h * 3600 + mi * 60 + sec) as f64;
    Ok(match offset {
        Some(o) => (wall - o as f64 * 60.0, None),
        None => tz.wall_to_utc(wall),
    })
}

/// A comma list of single numbers in `lo..=hi`, from a cron field that is
/// a number, a range `a-b`, or a list of those (no steps).
fn expand_field(field: &str, lo: i64, hi: i64) -> Option<Vec<i64>> {
    let mut out = Vec::new();
    for part in field.split(',') {
        if let Some((a, b)) = part.split_once('-') {
            let (a, b) = (a.parse::<i64>().ok()?, b.parse::<i64>().ok()?);
            if a > b {
                return None;
            }
            out.extend(a..=b);
        } else {
            out.push(part.parse::<i64>().ok()?);
        }
    }
    out.iter().all(|v| (lo..=hi).contains(v)).then_some(out)
}

fn join(mut v: Vec<i64>) -> String {
    v.sort_unstable();
    v.dedup();
    v.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

/// A "fixed time of day on some weekdays" cron rule: (minute, hour, the
/// day-of-week field). None for anything else (steps, several hours,
/// days of the month, months).
fn fixed_time_rule(expr: &str) -> Option<(i64, i64, String)> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    let [minute, hour, dom, month, dow] = fields.as_slice() else { return None };
    let single = |f: &str, hi: i64| f.parse::<i64>().ok().filter(|v| (0..=hi).contains(v));
    let (m, h) = (single(minute, 59)?, single(hour, 23)?);
    (*dom == "*" && *month == "*" && (*dow == "*" || expand_field(dow, 0, 7).is_some())).then(|| (m, h, dow.to_string()))
}

/// The weekday field moved by `shift` days (Sunday may be written 0 or 7).
fn shift_weekdays(dow: &str, shift: i64) -> String {
    if shift == 0 || dow == "*" {
        return dow.to_string();
    }
    let days = expand_field(dow, 0, 7).unwrap_or_default();
    join(days.iter().map(|d| (d % 7 + shift).rem_euclid(7)).collect())
}

const LOCAL_CRON_ONLY: &str = "With a local time, a repeating rule can only be a fixed time of day on chosen weekdays \
    (e.g. 9:00 Mon–Fri). For anything else, say it in UTC, or use an every-N interval.";

/// Shift a cron rule written in the user's local time to the UTC rule the
/// scheduler stores. Only the simple shape converts exactly — one time of
/// day, any or listed weekdays — rolling the weekday over when the hour
/// crosses midnight ("1am Mon–Fri" in IST is "19:30 Sun–Thu" UTC). Every
/// other shape is refused rather than approximated (a stepped or wildcard
/// hour, minute steps, days of the month or months can't keep their local
/// meaning once shifted). With no offset, the rule is already UTC.
pub fn local_cron_to_utc(expr: &str, offset_minutes: i32) -> Result<String, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err("a cron rule has 5 fields: minute hour day-of-month month day-of-week".into());
    }
    if offset_minutes == 0 {
        return Ok(fields.join(" "));
    }
    let (m, h, dow) = fixed_time_rule(expr).ok_or(LOCAL_CRON_ONLY)?;
    let t = h * 60 + m - offset_minutes as i64;
    let (shift, at) = (t.div_euclid(1440), t.rem_euclid(1440));
    Ok(format!("{} {} * * {}", at % 60, at / 60, shift_weekdays(&dow, shift)))
}

/// The spec the scheduler stores, an explicit first run, and a note when a
/// local time fell in a clock change — from what the model passed: `once`
/// with `at`, `interval` with `seconds` (optionally `start`), `cron` with
/// `expr` (local unless `utc: true`).
pub fn schedule_from_args(raw: &Value, tz: &TzHint) -> Result<(Value, Option<Value>, Option<String>), String> {
    match raw["kind"].as_str() {
        Some("once") => {
            let (at, note) = parse_when_noted(&raw["at"], tz)?;
            Ok((json!({"kind": "once", "at": at}), Some(json!(at)), note))
        }
        Some("interval") => {
            let seconds = raw["seconds"].as_i64().ok_or("an interval needs seconds (at least 300)")?;
            let (start, note) = match raw.get("start").filter(|v| !v.is_null()) {
                Some(v) => {
                    let (t, note) = parse_when_noted(v, tz)?;
                    (Some(json!(t)), note)
                }
                None => (None, None),
            };
            Ok((json!({"kind": "interval", "seconds": seconds}), start, note))
        }
        Some("cron") => {
            let expr = raw["expr"].as_str().ok_or("a cron schedule needs expr")?;
            let expr = if raw["utc"] == true { expr.split_whitespace().collect::<Vec<_>>().join(" ") } else { local_cron_to_utc(expr, tz.offset_minutes)? };
            Ok((json!({"kind": "cron", "expr": expr}), None, None))
        }
        _ => Err("schedule.kind must be once, interval or cron".into()),
    }
}

fn hhmm(minutes: i64) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// A time as the user reads it: their wall clock at that date, e.g.
/// "2026-10-26 09:00 your time" (plain UTC when the client sent no zone).
pub fn local_ts(t: f64, tz: &TzHint) -> String {
    let wall = crate::hub::format_ts(t + tz.offset_at(t) as f64 * 60.0);
    if tz.is_utc() { format!("{wall} UTC") } else { format!("{wall} your time") }
}

/// Weekdays in words: "every day", "on weekdays", "on Mon, Wed".
fn weekdays_words(dow: &str) -> String {
    if dow == "*" {
        return "every day".into();
    }
    let mut days: Vec<i64> = expand_field(dow, 0, 7).unwrap_or_default().iter().map(|d| d % 7).collect();
    days.sort_unstable();
    days.dedup();
    match days.as_slice() {
        [0, 1, 2, 3, 4, 5, 6] => "every day".into(),
        [1, 2, 3, 4, 5] => "on weekdays".into(),
        [0, 6] => "on weekends".into(),
        _ => {
            const NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            format!("on {}", days.iter().map(|d| NAMES[*d as usize]).collect::<Vec<_>>().join(", "))
        }
    }
}

/// A short spoken cadence for read-backs, in the user's own terms (cards
/// show the client's richer one). A UTC rule of the simple shape reads back
/// as local time with the UTC alongside; any other rule is read as written.
pub fn spoken_cadence(spec: &Value, tz: &TzHint) -> String {
    match spec["kind"].as_str() {
        Some("once") => format!("once at {}", local_ts(spec["at"].as_f64().unwrap_or(0.0), tz)),
        Some("interval") => {
            let s = spec["seconds"].as_i64().unwrap_or(0);
            let (n, unit) = if s % 604_800 == 0 { (s / 604_800, "week") } else if s % 86_400 == 0 { (s / 86_400, "day") } else if s % 3600 == 0 { (s / 3600, "hour") } else { (s / 60, "minute") };
            if n == 1 { format!("every {unit}") } else { format!("every {n} {unit}s") }
        }
        Some("cron") => {
            let expr = spec["expr"].as_str().unwrap_or_default();
            match fixed_time_rule(expr) {
                Some((m, h, dow)) if tz.is_utc() => format!("{} at {} UTC", weekdays_words(&dow), hhmm(h * 60 + m)),
                Some((m, h, dow)) => {
                    let t = h * 60 + m + tz.offset_minutes as i64;
                    let (shift, at) = (t.div_euclid(1440), t.rem_euclid(1440));
                    format!("{} at {} your time ({} UTC)", weekdays_words(&shift_weekdays(&dow, shift)), hhmm(at), hhmm(h * 60 + m))
                }
                None => format!("on the rule “{expr}” (UTC)"),
            }
        }
        _ => "on a schedule".into(),
    }
}

/// A repeating cron rule is stored in UTC: in a zone with daylight saving,
/// the local time it posts at moves by an hour twice a year. (A one-off is
/// converted for its own date, and an interval doesn't track the clock.)
fn dst_note(spec: &Value, tz: &TzHint) -> Option<&'static str> {
    (tz.has_dst && spec["kind"] == "cron").then_some(
        "Stored in UTC: when daylight saving changes, the local time this posts at shifts by an hour.",
    )
}

fn next_runs(spec: &Value, run_at: f64) -> Vec<f64> {
    Spec::from_stored(spec).map(|s| s.next_runs(run_at, 3)).unwrap_or_default()
}

// ------------------------------------------------------------------ tools

impl ToolCtx<'_> {
    pub(crate) fn tz(&self) -> TzHint {
        self.tz.clone()
    }

    fn destination(&self, channel_id: &str, thread_id: Option<i64>) -> String {
        let (cname, _, _) = self.channel_label(channel_id);
        let is_dm = self.store_ref().channel(channel_id).is_some_and(|c| c["kind"] == "agent_dm");
        match (is_dm, thread_id) {
            (true, _) => format!("your DM with {cname}"),
            (false, Some(_)) => format!("a thread in #{cname}"),
            (false, None) => format!("#{cname}"),
        }
    }

    /// `list_schedules`: the user's own schedules, live first, paged.
    pub(crate) fn list_schedules(&self, args: &Value, emit: &mut dyn FnMut(Value)) -> Result<Value, String> {
        let store = self.store_ref();
        let status = match args["status"].as_str().unwrap_or("all") {
            "all" | "" => None,
            s @ ("active" | "paused" | "done") => Some(s),
            other => return Err(format!("status must be all, active, paused or done (got “{other}”)")),
        };
        let channel = match args["channel"].as_str().filter(|s| !s.trim().is_empty()) {
            Some(c) => Some(self.channel_arg(c)?["id"].as_str().unwrap_or_default().to_string()),
            None => None,
        };
        let thread = args["thread_id"].as_i64();
        // Whether the scan hit its cap is a property of the scan, before the
        // channel / thread filter: a filtered list can look short while
        // schedules past the cap went unseen.
        let mut scanned = store.list_owner_schedules_by_status(&self.user.username, status, MAX_SCANNED + 1);
        let truncated = scanned.len() > MAX_SCANNED;
        scanned.truncate(MAX_SCANNED);
        let rows: Vec<Value> = scanned
            .into_iter()
            .filter(|s| channel.as_deref().is_none_or(|c| s["channel_id"] == c))
            .filter(|s| thread.is_none_or(|t| s["thread_id"].as_i64() == Some(t)))
            .collect();
        let total = rows.len();
        let offset = args["offset"].as_u64().unwrap_or(0) as usize;
        let limit = (args["limit"].as_u64().unwrap_or(MAX_LIST as u64) as usize).clamp(1, MAX_LIST);
        let viewer = Some((self.user.username.as_str(), self.user.instance_admin));
        let decorator = crate::hub::ScheduleDecorator::new(store, viewer, crate::store::now());
        let page: Vec<Value> = rows.iter().skip(offset).take(limit).map(|s| decorator.decorate(s)).collect();
        let has_more = offset + page.len() < total;
        if !page.is_empty() {
            emit(ev_card(json!({"kind": "schedules", "items": page, "total": total, "offset": offset,
                "has_more": has_more, "truncated": truncated})));
        }
        let items: Vec<Value> = page
            .iter()
            .map(|s| json!({
                "id": s["id"], "status": s["status"],
                "where": self.destination(s["channel_id"].as_str().unwrap_or_default(), s["thread_id"].as_i64()),
                "cadence": spoken_cadence(&s["schedule"], &self.tz),
                "next_run": s["next_runs"].get(0).and_then(Value::as_f64).map(|t| local_ts(t, &self.tz)),
                "last_error": s["last_error"],
                "text": crate::jarvis::clip(s["text"].as_str().unwrap_or_default(), 160),
            }))
            .collect();
        let mut note = "Only the user's own schedules. If what they asked about isn't here and has_more is true, \
                        call again with next_offset before saying it doesn't exist."
            .to_string();
        if truncated {
            note.push_str(&format!(
                " The user has more than {MAX_SCANNED} schedules, so this list may be incomplete: \
                 tell them, and narrow it by status (active / paused / done)."
            ));
        }
        Ok(json!({"items": items, "total": total, "offset": offset, "has_more": has_more,
            "next_offset": has_more.then_some(offset + page.len()), "truncated": truncated, "note": note}))
    }

    /// `draft_schedule`: a new schedule for the user to confirm.
    pub(crate) fn draft_schedule(&self, args: &Value, emit: &mut dyn FnMut(Value)) -> Result<Value, String> {
        let cid = args["channel_id"].as_str().unwrap_or_default().trim();
        crate::server::require_channel_postable(self.state, self.user, cid).map_err(crate::jarvis::detail)?;
        let text = args["text"].as_str().unwrap_or_default().trim().to_string();
        if text.is_empty() {
            return Err("text required: what should the scheduled message say?".into());
        }
        let mentions = self.mentions_for(cid, args)?;
        let tz = self.tz();
        let (spec, run_at, time_note) = schedule_from_args(&args["schedule"], &tz)?;
        // The @handles go into the stored text now: the post fires later,
        // with nobody there to add them.
        let probe = Draft { mentions: mentions.clone(), ..Draft::new(&self.user.username, cid, &text) };
        let full = probe.final_text(None);
        let checked = crate::hub::check_new_schedule(self.store_ref(), &self.user.username, cid, args["thread_id"].as_i64(),
            &full, &spec, run_at.as_ref(), crate::store::now())?;
        self.ensure_current()?;
        let destination = self.destination(cid, checked.thread_id);
        let draft = self.state.jarvis.create_draft(Draft {
            kind: DraftKind::ScheduleCreate {
                schedule: checked.schedule.clone(),
                run_at: checked.run_at,
                start: run_at.as_ref().and_then(Value::as_f64),
                time_note: time_note.clone(),
            },
            conversation_id: self.turn_conversation(),
            thread_id: checked.thread_id,
            mentions: mentions.clone(),
            destination: destination.clone(),
            ..Draft::new(&self.user.username, cid, &text)
        });
        self.note_created(&draft.id);
        let (cname, gid, gname) = self.channel_label(cid);
        emit(ev_card(json!({
            "kind": "schedule_draft", "draft_id": draft.id, "revision": draft.revision,
            "channel_id": cid, "channel_name": cname, "group_id": gid, "group_name": gname,
            "thread_id": checked.thread_id, "destination": destination,
            "text": draft.text, "final_text": draft.final_text(None),
            "mentions": draft.mentions.iter().map(|m| json!({"kind": m.kind, "id": m.id, "name": m.name, "handle": m.handle})).collect::<Vec<_>>(),
            "schedule": checked.schedule, "run_at": checked.run_at, "next_runs": next_runs(&checked.schedule, checked.run_at),
            "dst_note": dst_note(&checked.schedule, &tz), "time_note": time_note, "expires_in": DRAFT_TTL.as_secs(),
        })));
        self.supersede_for(&draft, emit);
        Ok(json!({"draft_id": draft.id, "status": "awaiting_user_confirmation", "destination": destination,
            "cadence": spoken_cadence(&checked.schedule, &tz),
"first_run": local_ts(checked.run_at, &tz), "text": draft.final_text(None), "time_note": time_note,
            "note": "Not scheduled yet. Agora reads it back and asks the user to confirm; they press Schedule or approve it, which is checked separately."}))
    }

    /// `draft_schedule_change`: pause / resume / cancel / retime one of the
    /// user's own schedules, for them to confirm.
    pub(crate) fn draft_schedule_change(&self, args: &Value, emit: &mut dyn FnMut(Value)) -> Result<Value, String> {
        let id = args["schedule_id"].as_str().unwrap_or_default().trim();
        let action = args["action"].as_str().unwrap_or_default();
        let tz = self.tz();
        let mut time_note = None;
        let change = match action {
            "pause" => OwnChange::Patch(json!({"status": "paused"})),
            "resume" => OwnChange::Patch(json!({"status": "active"})),
            "cancel" => OwnChange::Cancel,
            "retime" => {
                let mut body = json!({});
                if let Some(s) = args.get("schedule").filter(|v| !v.is_null()) {
                    let (spec, run_at, note) = schedule_from_args(s, &tz)?;
                    time_note = note;
                    body["schedule"] = spec;
                    if let Some(r) = run_at {
                        body["run_at"] = r;
                    }
                }
                if let Some(r) = args.get("run_at").filter(|v| !v.is_null()) {
                    let (t, note) = parse_when_noted(r, &tz)?;
                    time_note = note.or(time_note);
                    body["run_at"] = json!(t);
                }
                if body.as_object().is_some_and(|m| m.is_empty()) {
                    return Err("retime needs a new run_at or schedule".into());
                }
                OwnChange::Patch(body)
            }
            _ => return Err("action must be pause, resume, cancel or retime".into()),
        };
        let card = schedule_change_draft(self, id, action, change, time_note, None, emit)?;
        Ok(json!({"draft_id": card["draft_id"], "status": "awaiting_user_confirmation", "change": card["summary"],
            "time_note": card["time_note"], "note": "Not changed yet. Agora reads it back and asks the user to confirm."}))
    }
}

/// Build (and offer) a change draft for one of the user's own schedules:
/// the change is dry-run by the same rules as the app's own Pause / Resume /
/// Cancel / Change time, and bound to what the user can see change (status,
/// cadence, destination, owner — see [`change_fingerprint`]). Also used to
/// re-offer a fresh draft when the schedule changed before they confirmed:
/// `conversation` then carries the old draft's conversation over, so a
/// spoken yes can still confirm it. Returns the card.
pub(crate) fn schedule_change_draft(
    ctx: &ToolCtx,
    id: &str,
    action: &str,
    change: OwnChange,
    time_note: Option<String>,
    conversation: Option<String>,
    emit: &mut dyn FnMut(Value),
) -> Result<Value, String> {
    let (current, after) = crate::server::preview_own_change(ctx.state, ctx.user, id, &change).map_err(crate::jarvis::detail)?;
    ctx.ensure_current()?;
    let cid = current["channel_id"].as_str().unwrap_or_default().to_string();
    let thread_id = current["thread_id"].as_i64();
    let destination = ctx.destination(&cid, thread_id);
    let tz = ctx.tz();
    let was = spoken_cadence(&current["schedule"], &tz);
    let summary = match action {
        "pause" => format!("Pause the schedule in {destination} ({was})"),
        "resume" => format!("Resume the schedule in {destination} ({was})"),
        "cancel" => format!("Cancel the schedule in {destination} ({was})"),
        _ => format!(
            "Change the schedule in {destination} to run {}, next at {}",
            spoken_cadence(&after["schedule"], &tz),
            local_ts(after["run_at"].as_f64().unwrap_or(0.0), &tz)
        ),
    };
    let draft = ctx.state.jarvis.create_draft(Draft {
        kind: DraftKind::ScheduleChange {
            schedule_id: id.into(),
            action: action.into(),
            change,
            reviewed: change_fingerprint(&current),
            tz: tz.clone(),
            time_note: time_note.clone(),
        },
        conversation_id: conversation.or_else(|| ctx.turn_conversation()),
        thread_id,
        destination: destination.clone(),
        ..Draft::new(&ctx.user.username, &cid, &summary)
    });
    ctx.note_created(&draft.id);
    let viewer = Some((ctx.user.username.as_str(), ctx.user.instance_admin));
    let live = after["status"] == "active" || after["status"] == "paused";
    let card = json!({
        "kind": "schedule_change", "draft_id": draft.id, "revision": draft.revision, "action": action,
        "summary": summary, "destination": destination,
        "schedule": crate::hub::decorate_schedule(ctx.store_ref(), &current, viewer),
        "after": {"status": after["status"], "schedule": after["schedule"], "run_at": after["run_at"],
            "next_runs": if live { json!(next_runs(&after["schedule"], after["run_at"].as_f64().unwrap_or(0.0))) } else { json!([]) }},
        "dst_note": if action == "retime" { json!(dst_note(&after["schedule"], &tz)) } else { Value::Null },
        "time_note": time_note, "expires_in": DRAFT_TTL.as_secs(),
    });
    emit(ev_card(card.clone()));
    ctx.supersede_for(&draft, emit);
    Ok(card)
}

/// Drafts the previous turn offered for the same thing give way to `draft`.
impl ToolCtx<'_> {
    fn supersede_for(&self, draft: &Draft, emit: &mut dyn FnMut(Value)) {
        if let Some(t) = self.turn_ref() {
            for old in self.state.jarvis.supersede(t, draft) {
                emit(ev_draft_cancelled(&old, Some(&draft.id)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ist() -> TzHint {
        TzHint::fixed(330)
    }

    /// 2026-11-01 06:00 UTC: New York falls back from EDT (-4) to EST (-5).
    const NY_FALL_BACK: f64 = 1_793_512_800.0;
    /// 2027-03-14 07:00 UTC: New York springs forward to EDT.
    const NY_SPRING_FORWARD: f64 = 1_805_007_600.0;

    /// New York as an October client reports it: EDT now, with the coming
    /// changes.
    fn ny_in_october() -> TzHint {
        TzHint { offset_minutes: -240, has_dst: true, transitions: vec![(NY_FALL_BACK, -300), (NY_SPRING_FORWARD, -240)] }
    }

    fn utc_of(raw: &str, tz: &TzHint) -> String {
        crate::hub::format_ts(parse_when(&json!(raw), tz).unwrap())
    }

    #[test]
    fn local_times_convert_at_the_clients_offset_and_explicit_offsets_win() {
        // 2026-10-26 09:00 IST = 03:30 UTC.
        assert_eq!(utc_of("2026-10-26T09:00", &ist()), "2026-10-26 03:30");
        assert_eq!(parse_when(&json!("2026-10-26T09:00:00Z"), &ist()).unwrap(), parse_when(&json!("2026-10-26T09:00"), &TzHint::default()).unwrap());
        assert_eq!(parse_when(&json!("2026-10-26T09:00-04:00"), &ist()).unwrap() - parse_when(&json!("2026-10-26T13:00Z"), &ist()).unwrap(), 0.0);
        assert_eq!(utc_of("2026-10-26T09:00+14:00", &ist()), "2026-10-25 19:00");
        assert_eq!(parse_when(&json!(1_800_000_000.0), &ist()).unwrap(), 1_800_000_000.0);
        // Crossing midnight backwards: 01:00 IST on the 26th is the 25th in UTC.
        assert_eq!(utc_of("2026-10-26 01:00", &ist()), "2026-10-25 19:30");
    }

    #[test]
    fn impossible_local_times_are_refused_not_rolled_over() {
        for bad in ["2026-02-30T09:00", "2026-13-01T09:00", "2026-10-26T24:00", "2026-10-26T09:60", "tomorrow at 9", "2026-10-26",
            "2026-10-26T09:00+15:00", "2026-10-26T09:00-14:30", "2026-10-26T09:00+99:99", "2026-10-26T09:00+05:75"] {
            assert!(parse_when(&json!(bad), &ist()).is_err(), "{bad}");
        }
        assert!(parse_when(&json!("2028-02-29T09:00"), &ist()).is_ok(), "leap day exists in 2028");
        assert!(parse_when(&json!("2027-02-29T09:00"), &ist()).is_err());
    }

    #[test]
    fn a_local_time_converts_at_the_offset_in_force_on_its_date() {
        let ny = ny_in_october();
        // Said in October (EDT), Dec 1 9am is EST: 14:00 UTC, not 13:00.
        assert_eq!(utc_of("2026-12-01T09:00", &ny), "2026-12-01 14:00");
        assert_eq!(utc_of("2026-10-28T09:00", &ny), "2026-10-28 13:00");
        // Back on EDT after the spring change.
        assert_eq!(utc_of("2027-04-01T09:00", &ny), "2027-04-01 13:00");
        // The read-back shows the same wall time the user said.
        let t = parse_when(&json!("2026-12-01T09:00"), &ny).unwrap();
        assert_eq!(local_ts(t, &ny), "2026-12-01 09:00 your time");
        assert_eq!(spoken_cadence(&json!({"kind": "once", "at": t}), &ny), "once at 2026-12-01 09:00 your time");
    }

    #[test]
    fn clock_change_local_times_take_the_first_or_move_forward_with_a_note() {
        let ny = ny_in_october();
        // 01:30 on Nov 1 happens twice: the first (EDT) one, 05:30 UTC.
        let (t, note) = parse_when_noted(&json!("2026-11-01T01:30"), &ny).unwrap();
        assert_eq!(crate::hub::format_ts(t), "2026-11-01 05:30");
        assert!(note.unwrap().contains("twice"));
        // 02:30 on Mar 14 doesn't exist: moved forward to 03:30 EDT (07:30 UTC).
        let (t, note) = parse_when_noted(&json!("2027-03-14T02:30"), &ny).unwrap();
        assert_eq!(crate::hub::format_ts(t), "2027-03-14 07:30");
        assert_eq!(local_ts(t, &ny), "2027-03-14 03:30 your time");
        assert!(note.unwrap().contains("03:30"));
        // An ordinary time has no note; nor does an interval start outside a change.
        assert!(parse_when_noted(&json!("2026-12-01T09:00"), &ny).unwrap().1.is_none());
        let (_, start, note) = schedule_from_args(&json!({"kind": "interval", "seconds": 3600, "start": "2027-03-14T02:30"}), &ny).unwrap();
        assert_eq!(crate::hub::format_ts(start.unwrap().as_f64().unwrap()), "2027-03-14 07:30");
        assert!(note.is_some());
    }

    #[test]
    fn local_cron_converts_a_fixed_time_and_rolls_the_weekday_over_midnight() {
        // 1am Mon–Fri in IST is 19:30 Sun–Thu UTC.
        assert_eq!(local_cron_to_utc("0 1 * * 1-5", 330).unwrap(), "30 19 * * 0,1,2,3,4");
        // 00:30 Mon at UTC+1 is 23:30 Sun UTC.
        assert_eq!(local_cron_to_utc("30 0 * * 1", 60).unwrap(), "30 23 * * 0");
        // 10pm Fri in New York (winter) is 03:00 Sat UTC; Sat wraps to Sun.
        assert_eq!(local_cron_to_utc("0 22 * * 5", -300).unwrap(), "0 3 * * 6");
        assert_eq!(local_cron_to_utc("0 22 * * 6", -300).unwrap(), "0 3 * * 0");
        // Sunday written as 7 wraps back to Saturday.
        assert_eq!(local_cron_to_utc("0 2 * * 7", 330).unwrap(), "30 20 * * 6");
        // Same day: weekdays unchanged.
        assert_eq!(local_cron_to_utc("0 9 * * 1-5", 330).unwrap(), "30 3 * * 1-5");
        assert_eq!(local_cron_to_utc("0 9 * * *", 330).unwrap(), "30 3 * * *");
        // No offset: already UTC, any shape.
        assert_eq!(local_cron_to_utc("*/15 * * * *", 0).unwrap(), "*/15 * * * *");
    }

    #[test]
    fn local_cron_shapes_the_shift_cant_keep_are_refused() {
        for (expr, offset) in [
            ("0 * * * *", 330),     // every hour
            ("0 */2 * * *", 60),    // stepped hours
            ("*/10 9 * * *", 330),  // minute steps
            ("0 1,23 * * 1", 330),  // two hours on different UTC days
            ("0 1 15 * *", 330),    // a day of the month
            ("0 1 * 1 *", 330),     // a month
            ("0 9-17 * * 1-5", 60), // an hour range
        ] {
            let err = local_cron_to_utc(expr, offset).unwrap_err();
            assert!(err.contains("say it in UTC, or use an every-N interval"), "{expr}: {err}");
        }
        assert!(local_cron_to_utc("0 9 * *", 330).is_err(), "4 fields");
        // Stated in UTC, the same rules pass through unchanged.
        let (spec, _, _) = schedule_from_args(&json!({"kind": "cron", "expr": "0 */2 * * *", "utc": true}), &ist()).unwrap();
        assert_eq!(spec["expr"], "0 */2 * * *");
        assert!(schedule_from_args(&json!({"kind": "cron", "expr": "0 */2 * * *"}), &ist()).is_err());
    }

    #[test]
    fn specs_from_args_and_the_dst_note() {
        let (spec, run_at, _) = schedule_from_args(&json!({"kind": "cron", "expr": "0 9 * * 1-5"}), &ist()).unwrap();
        assert_eq!(spec, json!({"kind": "cron", "expr": "30 3 * * 1-5"}));
        assert!(run_at.is_none());
        let (spec, _, _) = schedule_from_args(&json!({"kind": "cron", "expr": "0  9 * * *", "utc": true}), &ist()).unwrap();
        assert_eq!(spec["expr"], "0 9 * * *");
        let ny = ny_in_october();
        let (once, run_at, _) = schedule_from_args(&json!({"kind": "once", "at": "2026-12-01T09:00"}), &ny).unwrap();
        assert_eq!(once["at"], run_at.unwrap());
        assert!(dst_note(&once, &ny).is_none(), "a one-off is converted for its own date");
        assert!(dst_note(&spec, &ny).is_some(), "a fixed-hour cron shifts with daylight saving");
        assert!(dst_note(&spec, &ist()).is_none(), "no DST in IST");
        assert!(dst_note(&json!({"kind": "interval", "seconds": 3600}), &ny).is_none(), "an interval doesn't track the clock");
        assert!(schedule_from_args(&json!({"kind": "sometimes"}), &ist()).is_err());
        assert_eq!(local_ts(parse_when(&json!("2026-10-26T09:00"), &ist()).unwrap(), &ist()), "2026-10-26 09:00 your time");
        assert_eq!(local_ts(0.0, &TzHint::default()), "1970-01-01 00:00 UTC");
    }

    #[test]
    fn cadences_read_back_in_the_users_own_time() {
        let cron = |e: &str| json!({"kind": "cron", "expr": e});
        assert_eq!(spoken_cadence(&cron("30 3 * * 1-5"), &ist()), "on weekdays at 09:00 your time (03:30 UTC)");
        // A UTC rule a day behind local reads with the local weekdays.
        assert_eq!(spoken_cadence(&cron("30 19 * * 0,1,2,3,4"), &ist()), "on weekdays at 01:00 your time (19:30 UTC)");
        assert_eq!(spoken_cadence(&cron("0 3 * * 6"), &TzHint::fixed(-300)), "on Fri at 22:00 your time (03:00 UTC)");
        assert_eq!(spoken_cadence(&cron("0 9 * * 0,6"), &TzHint::default()), "on weekends at 09:00 UTC");
        assert_eq!(spoken_cadence(&cron("30 3 * * *"), &ist()), "every day at 09:00 your time (03:30 UTC)");
        assert_eq!(spoken_cadence(&cron("0 */2 * * *"), &ist()), "on the rule “0 */2 * * *” (UTC)");
        assert_eq!(spoken_cadence(&json!({"kind": "interval", "seconds": 21_600}), &ist()), "every 6 hours");
    }

    #[test]
    fn the_change_fingerprint_ignores_what_a_run_moves() {
        let s = json!({"status": "active", "owner": "ana", "channel_id": "c1", "thread_id": null,
            "schedule": {"kind": "interval", "seconds": 3600}, "run_at": 100.0, "updated_at": 5.0, "last_run_at": null});
        let mut fired = s.clone();
        fired["run_at"] = json!(3700.0);
        fired["updated_at"] = json!(6.0);
        fired["last_run_at"] = json!(100.0);
        assert_eq!(change_fingerprint(&s), change_fingerprint(&fired));
        for (k, v) in [("status", json!("paused")), ("owner", json!("bo")), ("channel_id", json!("c2")), ("thread_id", json!(7))] {
            let mut edited = s.clone();
            edited[k] = v;
            assert_ne!(change_fingerprint(&s), change_fingerprint(&edited), "{k}");
        }
        let mut edited = s.clone();
        edited["schedule"]["seconds"] = json!(7200);
        assert_ne!(change_fingerprint(&s), change_fingerprint(&edited));
    }
}
