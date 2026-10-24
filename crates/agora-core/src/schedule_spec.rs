//! When a scheduled message fires: a JSON spec mirroring Pantheo's cron jobs
//! (`engine/cron/jobs.py`), so loops move between the two without
//! translation.
//!
//! ```json
//! {"kind": "once",     "at": 1792700000}
//! {"kind": "interval", "seconds": 7200}
//! {"kind": "cron",     "expr": "0 7 * * 1-5"}
//! ```
//!
//! Cron is standard 5-field, evaluated in UTC (as Pantheo's croniter is).

use chrono::{DateTime, Utc};
use croner::Cron;
use serde_json::{json, Value};

/// Below this an interval is more chat spam than cadence (Pantheo's floor).
pub const MIN_INTERVAL_SECS: i64 = 300;
/// How far ahead a one-off may be set; beyond this it's almost certainly a
/// unit mistake (ms vs s) rather than intent.
pub const MAX_LEAD_SECS: f64 = 400.0 * 86_400.0;
/// Clock skew tolerated between a client's "now" and ours when it sets a time.
pub const PAST_SKEW_SECS: f64 = 5.0;
/// Window of cron matches checked against the interval floor. Sub-floor gaps
/// can first appear at day/week/month boundaries (e.g. 23:59 Sun → 00:00 Mon),
/// so a few samples aren't enough; 32 days covers every month boundary shape.
const CRON_GAP_WINDOW_SECS: i64 = 32 * 86_400;
/// More matches than this inside the window means an average gap under the
/// floor (32 days / 10k ≈ 276 s), so hitting the cap is itself a rejection.
const CRON_GAP_MAX_MATCHES: usize = 10_000;

/// A due time as people read it in errors: whole seconds, rounded up, so a
/// stated floor ("no earlier than …") is never shown earlier than it is.
pub fn fmt_utc(ts: f64) -> String {
    chrono::DateTime::from_timestamp(ts.ceil() as i64, 0)
        .map(|d| d.format("%Y-%m-%d %H:%M:%S UTC").to_string())
        .unwrap_or_else(|| ts.to_string())
}

/// Reject a due time a writer sets in the past. A past time would fire on
/// the next tick (an admin could post as the owner on demand), and one that
/// equals an earlier fire's key would never fire at all.
pub fn require_future(t: f64, now_s: f64) -> Result<(), String> {
    if t < now_s - PAST_SKEW_SECS {
        return Err("that time is in the past; give a future time".into());
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub enum Spec {
    Once { at: f64 },
    Interval { seconds: i64 },
    // Boxed: a parsed pattern is far larger than the other variants.
    Cron { expr: String, cron: Box<Cron> },
}

fn utc(ts: f64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp(ts.floor() as i64, 0)
}

impl Spec {
    /// Load a spec already stored in a row: shape only, no write-time policy
    /// (lead limits, the cron floor). Stored specs were validated when
    /// written, and re-running the cron floor scan on every list/fire would
    /// be costly — and could orphan rows if policy tightens later.
    pub fn from_stored(value: &Value) -> Result<Spec, String> {
        let kind = value["kind"].as_str().ok_or(
            "schedule needs a kind: once ({\"kind\":\"once\",\"at\":<unix secs>}), interval \
             ({\"kind\":\"interval\",\"seconds\":N}) or cron ({\"kind\":\"cron\",\"expr\":\"0 7 * * *\"})",
        )?;
        match kind {
            "once" => {
                let at = value["at"]
                    .as_f64()
                    .filter(|at| at.is_finite() && *at > 0.0)
                    .ok_or("a once schedule needs `at` as unix seconds")?;
                Ok(Spec::Once { at })
            }
            "interval" => {
                let seconds = value["seconds"]
                    .as_i64()
                    .ok_or("an interval schedule needs whole `seconds`")?;
                // Only shape here: a stored row written under an older floor
                // must keep loading and advancing. The floor is write-time
                // policy (`parse`); a non-positive gap would never advance.
                if seconds <= 0 {
                    return Err("an interval schedule needs positive `seconds`".into());
                }
                Ok(Spec::Interval { seconds })
            }
            "cron" => {
                let expr = value["expr"]
                    .as_str()
                    .map(str::trim)
                    .filter(|e| !e.is_empty())
                    .ok_or("a cron schedule needs `expr`, e.g. \"0 7 * * *\"")?;
                if expr.split_whitespace().count() != 5 && !expr.starts_with('@') {
                    return Err(format!(
                        "cron expression '{expr}' must have 5 fields (minute hour day month weekday), in UTC"
                    ));
                }
                let cron = Cron::new(expr)
                    .parse()
                    .map_err(|e| format!("invalid cron expression '{expr}': {e}"))?;
                Ok(Spec::Cron { expr: expr.to_string(), cron: Box::new(cron) })
            }
            other => Err(format!("unknown schedule kind '{other}' (use once, interval or cron)")),
        }
    }

    /// Validate a client/agent-supplied spec at write time. Errors are
    /// user-facing.
    pub fn parse(value: &Value) -> Result<Spec, String> {
        let spec = Spec::from_stored(value)?;
        match &spec {
            Spec::Once { at } => {
                if *at > crate::store::now() + MAX_LEAD_SECS {
                    return Err("`at` is more than 400 days ahead — is it in milliseconds?".into());
                }
            }
            Spec::Interval { seconds } => {
                if *seconds < MIN_INTERVAL_SECS {
                    return Err(format!("interval must be at least {MIN_INTERVAL_SECS} seconds (5 minutes)"));
                }
                if *seconds as f64 > MAX_LEAD_SECS {
                    return Err("interval is more than 400 days — is it in milliseconds?".into());
                }
            }
            Spec::Cron { expr, cron } => check_cron_floor(expr, cron)?,
        }
        Ok(spec)
    }

    /// Write-time check (create/update): a one-off must be in the future.
    /// Kept out of `parse` so stored rows whose time passed still load.
    pub fn validate_future(&self, now_s: f64) -> Result<(), String> {
        match self {
            Spec::Once { at } => require_future(*at, now_s),
            _ => Ok(()),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Spec::Once { at } => json!({"kind": "once", "at": at}),
            Spec::Interval { seconds } => json!({"kind": "interval", "seconds": seconds}),
            Spec::Cron { expr, .. } => json!({"kind": "cron", "expr": expr}),
        }
    }

    fn cron_after(cron: &Cron, ts: f64) -> Option<f64> {
        cron.find_next_occurrence(&utc(ts)?, false)
            .ok()
            .map(|d| d.timestamp() as f64)
    }

    /// First due time for a new schedule (or one whose spec just changed).
    pub fn first_run(&self, now_s: f64) -> Option<f64> {
        match self {
            Spec::Once { at } => Some(*at),
            Spec::Interval { seconds } => Some(now_s + *seconds as f64),
            Spec::Cron { cron, .. } => Self::cron_after(cron, now_s),
        }
    }

    /// Due time after a fire at `due_at` (performed at `now_s`). Anchored to
    /// the previous slot so a recurring schedule keeps its phase, and after
    /// downtime the overdue slot fired once and the next is in the future —
    /// never a burst of missed slots. `None` = finished (one-off).
    pub fn next_after_fire(&self, due_at: f64, now_s: f64) -> Option<f64> {
        match self {
            Spec::Once { .. } => None,
            Spec::Interval { seconds } => Some(next_slot(due_at, *seconds, now_s)),
            Spec::Cron { cron, .. } => Self::cron_after(cron, due_at.max(now_s)),
        }
    }

    /// The next `n` due times starting at `run_at`, for UI previews.
    pub fn next_runs(&self, run_at: f64, n: usize) -> Vec<f64> {
        let mut out = vec![run_at];
        while out.len() < n {
            let last = *out.last().unwrap();
            let next = match self {
                Spec::Once { .. } => None,
                Spec::Interval { seconds } => Some(last + *seconds as f64),
                Spec::Cron { cron, .. } => Self::cron_after(cron, last),
            };
            match next {
                Some(t) => out.push(t),
                None => break,
            }
        }
        out
    }
}

/// A pattern that never matches (e.g. 30 February) would park the schedule
/// silently, and the interval floor applies to cron too, or `* * * * *` would
/// post every minute. Every gap across the next 32 days is checked, so
/// boundary gaps (end of day/week/month) are caught too.
fn check_cron_floor(expr: &str, cron: &Cron) -> Result<(), String> {
    let now = utc(crate::store::now()).ok_or("clock out of range")?;
    let first = cron
        .find_next_occurrence(&now, false)
        .map_err(|_| format!("cron expression '{expr}' never matches"))?;
    let too_often = || {
        format!("cron expression '{expr}' fires more often than every {} minutes", MIN_INTERVAL_SECS / 60)
    };
    let end = first + chrono::Duration::seconds(CRON_GAP_WINDOW_SECS);
    let mut prev = first;
    let mut matches = 1usize;
    while prev < end {
        let Ok(next) = cron.find_next_occurrence(&prev, false) else { break };
        if (next - prev).num_seconds() < MIN_INTERVAL_SECS {
            return Err(too_often());
        }
        matches += 1;
        if matches > CRON_GAP_MAX_MATCHES {
            return Err(too_often());
        }
        prev = next;
    }
    Ok(())
}

/// Next interval slot strictly after `now_s`, anchored to `prev`.
pub fn next_slot(prev: f64, seconds: i64, now_s: f64) -> f64 {
    let step = seconds.max(MIN_INTERVAL_SECS) as f64;
    let elapsed = (now_s - prev).max(0.0);
    prev + ((elapsed / step).floor() + 1.0) * step
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_round_trips_each_kind() {
        let at = crate::store::now() + 3600.0;
        for v in [
            json!({"kind": "once", "at": at}),
            json!({"kind": "interval", "seconds": 7200}),
            json!({"kind": "cron", "expr": "0 7 * * 1-5"}),
        ] {
            let spec = Spec::parse(&v).unwrap();
            assert_eq!(spec.to_json(), v);
            assert_eq!(Spec::parse(&spec.to_json()).unwrap().to_json(), v);
        }
    }

    #[test]
    fn rejects_bad_specs_with_helpful_errors() {
        assert!(Spec::parse(&json!({})).unwrap_err().contains("kind"));
        assert!(Spec::parse(&json!({"kind": "interval", "seconds": 60})).unwrap_err().contains("300"));
        assert!(Spec::parse(&json!({"kind": "cron", "expr": "61 * * * *"})).unwrap_err().contains("invalid cron"));
        assert!(Spec::parse(&json!({"kind": "cron", "expr": "* * * *"})).unwrap_err().contains("5 fields"));
        assert!(Spec::parse(&json!({"kind": "cron", "expr": "0 0 30 2 *"})).unwrap_err().contains("never matches"));
        assert!(Spec::parse(&json!({"kind": "once", "at": 1.7e12})).unwrap_err().contains("milliseconds"));
        assert!(Spec::parse(&json!({"kind": "weekly"})).unwrap_err().contains("unknown"));
        assert!(Spec::parse(&json!({"kind": "interval", "seconds": i64::MAX})).unwrap_err().contains("400 days"));
    }

    #[test]
    fn cron_obeys_the_interval_floor() {
        for expr in ["* * * * *", "*/1 * * * *", "*/4 * * * *", "0,2 * * * *", "0-10 7 * * *"] {
            let e = Spec::parse(&json!({"kind": "cron", "expr": expr})).unwrap_err();
            assert!(e.contains("more often"), "{expr}: {e}");
        }
        for expr in ["*/5 * * * *", "0 */6 * * *", "0 7 * * 1-5", "0,30 * * * *", "0 0 1 * *",
            "59 23 * * *", "55 23 * * 0", "0 0 * * 1"] {
            assert!(Spec::parse(&json!({"kind": "cron", "expr": expr})).is_ok(), "{expr}");
        }
    }

    #[test]
    fn cron_floor_catches_gaps_at_week_and_day_boundaries() {
        // 33 matches on Sunday hide the 23:59 Sun → 00:00 Mon gap from a
        // short sample; the full-window scan finds it.
        let e = Spec::parse(&json!({"kind": "cron",
            "expr": "0,6,12,18,24,30,36,42,48,54,59 0,12,23 * * 0,1"}))
        .unwrap_err();
        assert!(e.contains("more often"), "{e}");
        // 23:59 then 00:00 the next day is a one-minute gap.
        assert!(Spec::parse(&json!({"kind": "cron", "expr": "0,59 0,23 * * *"}))
            .unwrap_err()
            .contains("more often"));
    }

    #[test]
    fn stored_specs_load_without_write_time_policy() {
        // A stored cron that today's floor would reject still loads, so rows
        // never become unreadable when policy changes.
        let spec = Spec::from_stored(&json!({"kind": "cron", "expr": "* * * * *"})).unwrap();
        assert!(matches!(spec, Spec::Cron { .. }));
        assert!(Spec::from_stored(&json!({"kind": "once", "at": 1000.0})).is_ok());
        assert!(Spec::from_stored(&json!({"kind": "nope"})).is_err());
        // An interval stored under an older (lower) floor still loads and
        // keeps advancing, instead of finishing silently after one post.
        let short = Spec::from_stored(&json!({"kind": "interval", "seconds": 60})).unwrap();
        assert!(short.next_after_fire(1000.0, 1001.0).is_some_and(|t| t > 1001.0));
        assert!(Spec::parse(&json!({"kind": "interval", "seconds": 60})).is_err(), "floor stays at write time");
        assert!(Spec::from_stored(&json!({"kind": "interval", "seconds": 0})).is_err());
    }

    #[test]
    fn cron_is_utc_and_catches_up_once_after_downtime() {
        // 2026-10-20 07:00:00 UTC.
        let seven = 1_792_479_600.0;
        let spec = Spec::parse(&json!({"kind": "cron", "expr": "0 7 * * *"})).unwrap();
        assert_eq!(spec.first_run(seven - 60.0), Some(seven));
        // On time: next is tomorrow 07:00.
        assert_eq!(spec.next_after_fire(seven, seven + 5.0), Some(seven + 86_400.0));
        // Down for 3 days: the overdue slot fires once, then the next future match.
        let back = seven + 3.0 * 86_400.0 + 3600.0;
        assert_eq!(spec.next_after_fire(seven, back), Some(seven + 4.0 * 86_400.0));
        assert_eq!(spec.next_runs(seven, 3), vec![seven, seven + 86_400.0, seven + 172_800.0]);
    }

    #[test]
    fn interval_is_anchored_without_bursts() {
        let spec = Spec::parse(&json!({"kind": "interval", "seconds": 3600})).unwrap();
        assert_eq!(spec.next_after_fire(1000.0, 1010.0), Some(4600.0));
        // Ten hours late: one catch-up, next slot keeps the phase.
        assert_eq!(spec.next_after_fire(1000.0, 1000.0 + 36_000.0 + 5.0), Some(1000.0 + 39_600.0));
        assert_eq!(spec.next_runs(1000.0, 3), vec![1000.0, 4600.0, 8200.0]);
        let once = Spec::parse(&json!({"kind": "once", "at": 5000.0})).unwrap();
        assert_eq!(once.next_after_fire(5000.0, 5001.0), None);
        assert_eq!(once.next_runs(5000.0, 3), vec![5000.0]);
    }
}
