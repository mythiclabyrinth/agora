//! REST for scheduled messages, for people. Creating a schedule and editing
//! its text are agent-only (an agent acting for the owner, see
//! hub/scheduler.rs); people view, pause, resume, cancel and retime here.
//!
//! Who may manage a schedule: its owner, a channel admin, or an instance
//! admin — except in agent DMs, which stay owner-only for everyone.

use super::*;
use crate::hub::{cancel_change, decorate_schedule, plan_change, ChangeRequest, PlanError, ScheduleDecorator};
use crate::store::UpdateRefused;

fn viewer(user: &AuthedUser) -> Option<(&str, bool)> {
    Some((user.username.as_str(), user.instance_admin))
}

/// Most schedules a list endpoint returns. Rows arrive live-first (active,
/// then paused, then finished, each soonest-due first), so a cap drops the
/// least relevant ones; an admin's inbox can span every channel.
pub(super) const MAX_LISTED: usize = 1000;

/// `{items}` decorated, at most [`MAX_LISTED`], with `truncated: true` only
/// when rows were left out.
fn capped_list(rows: &[Value], decorate: impl Fn(&Value) -> Value) -> Value {
    let items: Vec<Value> = rows.iter().take(MAX_LISTED).map(decorate).collect();
    if rows.len() > MAX_LISTED {
        json!({"items": items, "truncated": true})
    } else {
        json!({"items": items})
    }
}

/// GET /api/channels/{channel_id}/schedules[?thread_id=] — the channel's
/// schedules, thread ones included and labelled, or just one thread's.
pub(super) async fn list_channel_schedules(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let thread_id = match q.get("thread_id").filter(|s| !s.is_empty()) {
        Some(raw) => {
            let tid = raw.parse::<i64>().map_err(|_| err(StatusCode::BAD_REQUEST, "thread_id must be a number"))?;
            resolve_thread(&state, &channel_id, Some(tid))?
        }
        None => None,
    };
    let items = tokio::task::spawn_blocking(move || {
        let store = &state.hub.store;
        let decorator = ScheduleDecorator::new(store, viewer(&user), now());
        let rows = store.list_schedules_for_channel(&channel_id, thread_id);
        capped_list(&rows, |s| decorator.decorate(s))
    })
    .await
    .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Schedule query failed"))?;
    Ok(Json(items))
}

/// GET /api/schedules — every schedule in channels the caller can access
/// (admins: all channels; DMs stay owner-only), for the inbox tab. The
/// caller's own schedules are always included, even in a channel they've
/// since lost access to (flagged `channel_access: false`), so they can still
/// see and cancel what posts in their name.
pub(super) async fn list_schedules(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let items = tokio::task::spawn_blocking(move || {
        let store = &state.hub.store;
        let decorator = ScheduleDecorator::new(store, viewer(&user), now());
        let rows = store.list_visible_schedules(&user.username, user.instance_admin);
        capped_list(&rows, |s| decorator.decorate(s))
    })
    .await
    .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Schedule query failed"))?;
    Ok(Json(items))
}

/// The schedule, if the caller may manage it, and whether they can still see
/// its channel. Anyone but the owner must see the channel first (someone who
/// can't learns nothing more). The owner keeps a way out of a channel they
/// were removed from: they may still pause or cancel their own schedule there.
fn require_manageable(state: &AppState, user: &AuthedUser, id: &str) -> Result<(Value, bool), ApiError> {
    let schedule = state
        .hub
        .store
        .schedule(id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown schedule"))?;
    let channel_id = schedule["channel_id"].as_str().unwrap_or_default();
    let is_owner = schedule["owner"].as_str() == Some(user.username.as_str());
    let access = require_channel_member(state, user, channel_id);
    if !is_owner {
        access?;
    }
    let decorated = decorate_schedule(&state.hub.store, &schedule, viewer(user));
    if decorated["can_manage"] != true {
        return Err(err(
            StatusCode::FORBIDDEN,
            "Only the schedule's owner or a channel admin can change it",
        ));
    }
    Ok((schedule, decorated["channel_access"] == true))
}

/// PATCH /api/schedules/{id} — `{run_at?, schedule?, status?: "paused"|"active"}`.
pub(super) async fn update_schedule(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    // Spec validation (a cron rule is checked over a month of matches) and
    // the store writes run off the async worker.
    let blocking = state.clone();
    tokio::task::spawn_blocking(move || patch_schedule(&blocking, &user, &id, &body))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Updating the schedule failed"))?
        .map(Json)
}

fn refused(e: UpdateRefused, owner: &str) -> ApiError {
    match e {
        UpdateRefused::Missing => err(StatusCode::NOT_FOUND, "Unknown schedule"),
        UpdateRefused::Rate => err(StatusCode::TOO_MANY_REQUESTS, &e.message(owner)),
        UpdateRefused::Changed | UpdateRefused::Cap => err(StatusCode::CONFLICT, &e.message(owner)),
    }
}

fn patch_schedule(state: &AppState, user: &AuthedUser, id: &str, body: &Value) -> Result<Value, ApiError> {
    let (current, channel_access) = require_manageable(state, user, id)?;
    patch_current(state, user, id, current, channel_access, body)
}

/// PATCH against the row the caller checked: the write is conditional on
/// `current`, so a change made in between is refused, never overwritten.
fn patch_current(state: &AppState, user: &AuthedUser, id: &str, current: Value, channel_access: bool, body: &Value) -> Result<Value, ApiError> {
    let Some(change) = plan_patch(state, user, &current, channel_access, body)? else {
        // e.g. resuming an already-active schedule: nothing to write.
        return Ok(json!({"schedule": decorate_schedule(&state.hub.store, &current, viewer(user))}));
    };
    let owner = current["owner"].as_str().unwrap_or_default();
    let updated = state
        .hub
        .store
        .update_schedule_if(id, &current, &change, &user.username, None)
        .map_err(|e| refused(e, owner))?;
    state.hub.publish_for(&updated);
    Ok(json!({"schedule": decorate_schedule(&state.hub.store, &updated, viewer(user))}))
}

/// The write a PATCH `body` makes to `current`, by the PATCH rules; None
/// when there is nothing to write.
fn plan_patch(
    state: &AppState,
    user: &AuthedUser,
    current: &Value,
    channel_access: bool,
    body: &Value,
) -> Result<Option<crate::store::ScheduleChange>, ApiError> {
    // An owner who lost the channel may only stop their schedule, never
    // retime or revive a post into a conversation they can't see.
    if !channel_access {
        let pause_only = body.as_object().is_some_and(|m| {
            m.iter().all(|(k, v)| v.is_null() || (k == "status" && v == "paused"))
                && m.get("status").is_some_and(|v| v == "paused")
        });
        if !pause_only {
            return Err(err(
                StatusCode::FORBIDDEN,
                "You no longer have access to this channel; you can only pause or cancel this schedule",
            ));
        }
    }
    // `text: null` is just an absent field (some clients serialise every key).
    if body.get("text").is_some_and(|v| !v.is_null()) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "A schedule's message is edited through an agent acting for its owner, not here",
        ));
    }
    // The posts go out in the owner's name, so only the owner decides how
    // often; an admin can still pause, cancel or move the next time.
    if body.get("schedule").is_some_and(|v| !v.is_null()) && current["owner"].as_str() != Some(user.username.as_str()) {
        return Err(err(
            StatusCode::FORBIDDEN,
            "Only the schedule's owner can change how often it posts; you can pause, cancel or change its next time",
        ));
    }
    let req = ChangeRequest {
        text: None,
        schedule: body.get("schedule"),
        run_at: body.get("run_at"),
        status: match body.get("status") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_str().ok_or_else(|| err(StatusCode::BAD_REQUEST, "status must be \"paused\" or \"active\""))?),
        },
        non_owner: current["owner"].as_str() != Some(user.username.as_str()),
        postpone_only: current["owner"].as_str() != Some(user.username.as_str()),
    };
    let change = plan_change(&state.hub.store, current, &req, now()).map_err(|e| match e {
        PlanError::Bad(m) => err(StatusCode::BAD_REQUEST, &m),
        PlanError::Conflict(m) => err(StatusCode::CONFLICT, &m),
    })?;
    Ok((!change.is_empty()).then_some(change))
}

pub(crate) use crate::jarvis_schedules::OwnChange;

/// The caller's own schedule — Jarvis acts for the person, never with an
/// admin's reach over other people's schedules. Someone else's is reported
/// as unknown, so a guessed id learns nothing.
pub(crate) fn own_schedule(state: &AppState, user: &AuthedUser, id: &str) -> Result<Value, ApiError> {
    state
        .hub
        .store
        .schedule(id)
        .filter(|s| s["owner"].as_str() == Some(user.username.as_str()))
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "That isn't one of your schedules"))
}

/// Dry run of a change on the caller's own schedule, by the same rules as
/// PATCH/DELETE; nothing is written. Returns (current row, row as it would
/// be after).
pub(crate) fn preview_own_change(state: &AppState, user: &AuthedUser, id: &str, change: &OwnChange) -> Result<(Value, Value), ApiError> {
    own_schedule(state, user, id)?;
    let (current, channel_access) = require_manageable(state, user, id)?;
    let planned = match change {
        OwnChange::Cancel => cancel_change(&current).map_err(|m| err(StatusCode::CONFLICT, &m))?,
        OwnChange::Patch(body) => {
            if !channel_access && body.get("status").and_then(Value::as_str) != Some("paused") {
                return Err(err(StatusCode::FORBIDDEN, "You no longer have access to this channel; you can only pause or cancel this schedule"));
            }
            let req = ChangeRequest {
                text: None,
                schedule: body.get("schedule").filter(|v| !v.is_null()),
                run_at: body.get("run_at").filter(|v| !v.is_null()),
                status: body.get("status").and_then(Value::as_str),
                non_owner: false,
                postpone_only: false,
            };
            plan_change(&state.hub.store, &current, &req, now()).map_err(|e| match e {
                PlanError::Bad(m) => err(StatusCode::BAD_REQUEST, &m),
                PlanError::Conflict(m) => err(StatusCode::CONFLICT, &m),
            })?
        }
    };
    let mut after = current.clone();
    if let Some(t) = planned.run_at {
        after["run_at"] = json!(t);
    }
    if let Some(s) = planned.schedule {
        after["schedule"] = s;
    }
    if let Some(s) = planned.status {
        after["status"] = json!(s);
    }
    Ok((current, after))
}

/// Apply a confirmed change to the caller's own schedule, by the same rules
/// as PATCH/DELETE. `reviewed` is the fingerprint of what the person saw
/// (status, cadence, destination, owner): if any of that changed since,
/// nothing is written (`Ok(None)`) so the caller can show them the schedule
/// as it is now. A run firing meanwhile only moves bookkeeping, so the change
/// is planned against the current row and applies; if the row moves between
/// that read and the write, it is re-read and tried again (once).
pub(crate) fn apply_own_change(
    state: &AppState,
    user: &AuthedUser,
    id: &str,
    change: &OwnChange,
    reviewed: &str,
) -> Result<Option<Value>, ApiError> {
    for attempt in 0..2 {
        own_schedule(state, user, id)?;
        let (current, channel_access) = require_manageable(state, user, id)?;
        if crate::jarvis_schedules::change_fingerprint(&current) != reviewed {
            return Ok(None);
        }
        let planned = match change {
            OwnChange::Patch(body) => plan_patch(state, user, &current, channel_access, body)?,
            OwnChange::Cancel => Some(cancel_change(&current).map_err(|m| err(StatusCode::CONFLICT, &m))?),
        };
        let Some(planned) = planned else {
            return Ok(Some(decorate_schedule(&state.hub.store, &current, viewer(user))));
        };
        match state.hub.store.update_schedule_if(id, &current, &planned, &user.username, None) {
            Ok(updated) => {
                state.hub.publish_for(&updated);
                return Ok(Some(decorate_schedule(&state.hub.store, &updated, viewer(user))));
            }
            Err(UpdateRefused::Changed) if attempt == 0 => continue,
            // Still moving: let the caller re-check what the person saw.
            Err(UpdateRefused::Changed) => return Ok(None),
            Err(e) => return Err(refused(e, &user.username)),
        }
    }
    Ok(None)
}

/// PATCH as `user`, for tests of what a concurrent edit does.
#[cfg(test)]
pub(crate) fn patch_for_test(state: &AppState, user: &AuthedUser, id: &str, body: &Value) -> Result<Value, ApiError> {
    patch_schedule(state, user, id, body)
}

/// DELETE /api/schedules/{id} — cancel (kept as history, hidden from lists).
pub(super) async fn delete_schedule(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let (current, _) = require_manageable(&state, &user, &id)?;
    let change = cancel_change(&current).map_err(|m| err(StatusCode::CONFLICT, &m))?;
    let owner = current["owner"].as_str().unwrap_or_default();
    let updated = state
        .hub
        .store
        .update_schedule_if(&id, &current, &change, &user.username, None)
        .map_err(|e| refused(e, owner))?;
    state.hub.publish_for(&updated);
    Ok(Json(json!({"ok": true})))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{admin_headers, session_headers, test_state};
    use super::*;
    use crate::store::ScheduleChange;

    struct Fixture {
        state: AppState,
        _dir: tempfile::TempDir,
        cid: String,
        dm: String,
        sid: String,
        dm_sid: String,
    }

    fn fixture() -> Fixture {
        let (state, dir) = test_state();
        let store = &state.hub.store;
        for (u, role) in [("ana", "member"), ("bob", "member"), ("cat", "member"), ("eve", "member"), ("root", "admin")] {
            store.create_user(u, u, None, role).unwrap();
        }
        let g = store.create_group("Team", "", None);
        let gid = g["id"].as_str().unwrap();
        store.add_member(gid, "user", "ana", "member", None);
        store.add_member(gid, "user", "bob", "member", None);
        store.add_member(gid, "user", "cat", "admin", None);
        let cid = store.create_channel(gid, "main", "")["id"].as_str().unwrap().to_string();
        store.upsert_agent("claude", "Claude", "test", false, false, 0);
        store.set_agent_dm_policy("claude", true, &[]);
        let dm = store.open_agent_dm("ana", "claude", "Claude")["id"].as_str().unwrap().to_string();
        let at = now() + 3600.0;
        let spec = json!({"kind": "once", "at": at});
        let sid = store.create_schedule("ana", &cid, None, "hello", at, &spec, "ana", Some("claude"))["id"]
            .as_str().unwrap().to_string();
        let dm_sid = store.create_schedule("ana", &dm, None, "private", at, &spec, "ana", None)["id"]
            .as_str().unwrap().to_string();
        Fixture { state, _dir: dir, cid, dm, sid, dm_sid }
    }

    async fn channel_list(f: &Fixture, cid: &str, headers: HeaderMap) -> Result<Value, StatusCode> {
        list_channel_schedules(State(f.state.clone()), Path(cid.to_string()), Query(HashMap::new()), headers)
            .await
            .map(|Json(v)| v)
            .map_err(|e| e.into_response().status())
    }

    async fn inbox(f: &Fixture, headers: HeaderMap) -> Value {
        let Json(v) = list_schedules(State(f.state.clone()), Query(HashMap::new()), headers).await.ok().unwrap();
        v
    }

    async fn patch(f: &Fixture, id: &str, headers: HeaderMap, body: Value) -> Result<Value, StatusCode> {
        update_schedule(State(f.state.clone()), Path(id.to_string()), Query(HashMap::new()), headers, Json(body))
            .await
            .map(|Json(v)| v)
            .map_err(|e| e.into_response().status())
    }

    async fn cancel(f: &Fixture, id: &str, headers: HeaderMap) -> StatusCode {
        match delete_schedule(State(f.state.clone()), Path(id.to_string()), Query(HashMap::new()), headers).await {
            Ok(_) => StatusCode::OK,
            Err(e) => e.into_response().status(),
        }
    }

    #[tokio::test]
    async fn listing_follows_channel_access_and_dm_privacy() {
        let f = fixture();
        let s = &f.state;
        let ana = channel_list(&f, &f.cid, session_headers(s, "ana")).await.unwrap();
        let item = &ana["items"][0];
        assert_eq!(item["can_manage"], true);
        assert_eq!(item["owner_name"], "ana");
        assert_eq!(item["channel_name"], "main");
        assert_eq!(item["next_runs"].as_array().unwrap().len(), 1);
        let bob = channel_list(&f, &f.cid, session_headers(s, "bob")).await.unwrap();
        assert_eq!(bob["items"][0]["can_manage"], false, "a plain member sees but can't manage");
        assert_eq!(channel_list(&f, &f.cid, session_headers(s, "eve")).await.unwrap_err(), StatusCode::FORBIDDEN);
        assert_eq!(channel_list(&f, &f.dm, session_headers(s, "root")).await.unwrap_err(), StatusCode::FORBIDDEN);
        assert_eq!(inbox(&f, session_headers(s, "ana")).await["items"].as_array().unwrap().len(), 2);
        let admin = inbox(&f, session_headers(s, "root")).await;
        assert_eq!(admin["items"].as_array().unwrap().len(), 1, "admins see all channels but not others' DMs");
        assert_eq!(admin["items"][0]["can_manage"], true);
        assert_eq!(inbox(&f, admin_headers(s)).await["items"].as_array().unwrap().len(), 1);
        assert!(inbox(&f, session_headers(s, "eve")).await["items"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_owner_channel_admin_or_instance_admin_may_change_it() {
        let f = fixture();
        let s = &f.state;
        let later = now() + 7200.0;
        assert_eq!(patch(&f, &f.sid, session_headers(s, "bob"), json!({"run_at": later})).await.unwrap_err(), StatusCode::FORBIDDEN);
        assert_eq!(patch(&f, &f.sid, session_headers(s, "eve"), json!({"run_at": later})).await.unwrap_err(), StatusCode::FORBIDDEN);
        assert_eq!(cancel(&f, &f.sid, session_headers(s, "bob")).await, StatusCode::FORBIDDEN);
        let owner = patch(&f, &f.sid, session_headers(s, "ana"), json!({"run_at": later})).await.unwrap();
        assert_eq!(owner["schedule"]["run_at"], later);
        assert_eq!(owner["schedule"]["updated_by"], "ana");
        assert_eq!(owner["schedule"]["via_agent"], "claude", "a person's change keeps the agent provenance");
        let paused = patch(&f, &f.sid, session_headers(s, "cat"), json!({"status": "paused"})).await.unwrap();
        assert_eq!(paused["schedule"]["status"], "paused");
        // A second pause (double-click, another device) succeeds without a write.
        let again = patch(&f, &f.sid, session_headers(s, "cat"), json!({"status": "paused"})).await.unwrap();
        assert_eq!(again["schedule"]["status"], "paused");
        assert_eq!(again["schedule"]["updated_at"], paused["schedule"]["updated_at"]);
        let resumed =patch(&f, &f.sid, session_headers(s, "root"), json!({"status": "active"})).await.unwrap();
        assert_eq!(resumed["schedule"]["status"], "active");
        // DMs stay owner-only, admins included.
        assert_eq!(patch(&f, &f.dm_sid, session_headers(s, "root"), json!({"status": "paused"})).await.unwrap_err(), StatusCode::FORBIDDEN);
        assert_eq!(cancel(&f, &f.sid, session_headers(s, "ana")).await, StatusCode::OK);
        assert!(channel_list(&f, &f.cid, session_headers(s, "ana")).await.unwrap()["items"].as_array().unwrap().is_empty());
        assert_eq!(patch(&f, &f.sid, session_headers(s, "ana"), json!({"run_at": later})).await.unwrap_err(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn people_retime_and_reschedule_but_never_edit_text() {
        let f = fixture();
        let s = &f.state;
        let ana = || session_headers(s, "ana");
        assert_eq!(patch(&f, &f.sid, ana(), json!({"text": "rewritten"})).await.unwrap_err(), StatusCode::BAD_REQUEST);
        assert_eq!(patch(&f, &f.sid, ana(), json!({"schedule": {"kind": "cron", "expr": "99 * * * *"}})).await.unwrap_err(), StatusCode::BAD_REQUEST);
        assert_eq!(patch(&f, &f.sid, ana(), json!({"schedule": {"kind": "interval", "seconds": 10}})).await.unwrap_err(), StatusCode::BAD_REQUEST);
        assert_eq!(patch(&f, &f.sid, ana(), json!({})).await.unwrap_err(), StatusCode::BAD_REQUEST);
        let cron = patch(&f, &f.sid, ana(), json!({"schedule": {"kind": "cron", "expr": "30 6 * * 1-5"}})).await.unwrap();
        let item = &cron["schedule"];
        assert_eq!(item["schedule"], json!({"kind": "cron", "expr": "30 6 * * 1-5"}));
        assert_eq!(item["next_runs"].as_array().unwrap().len(), 3);
        assert!(item["run_at"].as_f64().unwrap() > now());
        assert_eq!(item["text"], "hello");
    }

    #[tokio::test]
    async fn routes_are_mounted_and_authenticated() {
        use axum::body::to_bytes;
        use axum::http::Request;
        use tower::ServiceExt;
        let f = fixture();
        let app = router(f.state.clone());
        let unauth = app.clone().oneshot(Request::get("/api/schedules").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
        let token = session_headers(&f.state, "ana")["authorization"].to_str().unwrap().to_string();
        let ok = app
            .oneshot(Request::get(format!("/api/channels/{}/schedules", f.cid))
                .header("authorization", token).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(&to_bytes(ok.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert_eq!(body["items"][0]["id"], f.sid.as_str());
    }

    #[tokio::test]
    async fn lists_are_capped_soonest_first_and_say_so() {
        let f = fixture();
        let store = &f.state.hub.store;
        let base = now() + 60.0;
        for i in 0..MAX_LISTED {
            let at = base + i as f64;
            store.create_schedule("ana", &f.cid, None, "bulk", at, &json!({"kind": "once", "at": at}), "ana", None);
        }
        // The fixture's own schedule (due in an hour) is now past the cap.
        let v = channel_list(&f, &f.cid, session_headers(&f.state, "ana")).await.unwrap();
        assert_eq!(v["items"].as_array().unwrap().len(), MAX_LISTED);
        assert_eq!(v["truncated"], true);
        assert!(v["items"].as_array().unwrap().iter().all(|i| i["id"] != f.sid.as_str()), "latest due is dropped");
        let inbox_v = inbox(&f, session_headers(&f.state, "ana")).await;
        assert_eq!(inbox_v["items"].as_array().unwrap().len(), MAX_LISTED);
        assert_eq!(inbox_v["truncated"], true);
        // Uncapped lists carry no flag.
        let small = fixture();
        let v = channel_list(&small, &small.cid, session_headers(&small.state, "ana")).await.unwrap();
        assert!(v.get("truncated").is_none(), "{v}");
    }

    #[tokio::test]
    async fn live_schedules_list_first_and_survive_the_cap_behind_finished_ones() {
        let f = fixture();
        let store = &f.state.hub.store;
        // More recently finished one-offs than the cap: each keeps the past
        // slot it fired on, which sorts ahead of every live schedule by time.
        let done = ScheduleChange { status: Some("done".into()), ..Default::default() };
        for i in 0..=MAX_LISTED {
            let at = now() - 3600.0 + i as f64 * 0.001;
            let id = store.create_schedule("ana", &f.cid, None, "finished", at, &json!({"kind": "once", "at": at}), "ana", None)
                ["id"].as_str().unwrap().to_string();
            store.update_schedule(&id, &done, "ana", None).unwrap();
        }
        for v in [
            channel_list(&f, &f.cid, session_headers(&f.state, "ana")).await.unwrap(),
            inbox(&f, session_headers(&f.state, "ana")).await,
        ] {
            let items = v["items"].as_array().unwrap();
            assert_eq!(v["truncated"], true);
            assert!(items.iter().any(|i| i["id"] == f.sid.as_str()), "the live schedule survives the cap");
            let first_done = items.iter().position(|i| i["status"] == "done").unwrap();
            assert!(first_done >= 1, "live schedules lead the list");
            assert!(items[first_done..].iter().all(|i| i["status"] == "done"), "no live row after a finished one");
        }
    }

    #[tokio::test]
    async fn the_thread_filter_scopes_a_channel_list_to_one_thread() {
        let f = fixture();
        let s = &f.state;
        let store = &s.hub.store;
        let root = store.add_message(&f.cid, "root", "user", "ana", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        let reply = store.add_message(&f.cid, "reply", "user", "ana", None, Some(root_id), &[]);
        let at = now() + 3600.0;
        let tsid = store.create_schedule("ana", &f.cid, Some(root_id), "in thread", at,
            &json!({"kind": "once", "at": at}), "ana", None)["id"].as_str().unwrap().to_string();
        let list = |tid: Option<&str>| {
            let mut q = HashMap::new();
            if let Some(t) = tid {
                q.insert("thread_id".to_string(), t.to_string());
            }
            list_channel_schedules(State(s.clone()), Path(f.cid.clone()), Query(q), session_headers(s, "ana"))
        };
        let ids = |v: &Value| -> Vec<String> {
            v["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect()
        };
        let Json(all) = list(None).await.ok().unwrap();
        let all_ids = ids(&all);
        assert!(all_ids.contains(&f.sid) && all_ids.contains(&tsid), "channel view lists both: {all_ids:?}");
        let Json(thread) = list(Some(&root_id.to_string())).await.ok().unwrap();
        assert_eq!(ids(&thread), vec![tsid.clone()], "only the thread's schedule");
        assert_eq!(thread["items"][0]["thread_id"], root_id);
        // A reply id continues its thread, like a live post.
        let Json(via_reply) = list(Some(&reply["id"].as_i64().unwrap().to_string())).await.ok().unwrap();
        assert_eq!(ids(&via_reply), vec![tsid]);
        let status = |r: Result<Json<Value>, ApiError>| r.err().map(|e| e.into_response().status());
        assert_eq!(status(list(Some("999999")).await), Some(StatusCode::NOT_FOUND));
        assert_eq!(status(list(Some("abc")).await), Some(StatusCode::BAD_REQUEST));
    }

    #[tokio::test]
    async fn only_the_owner_changes_how_often_admins_only_the_time() {
        let f = fixture();
        let s = &f.state;
        let every = json!({"schedule": {"kind": "interval", "seconds": 300}});
        for admin in ["cat", "root"] {
            assert_eq!(patch(&f, &f.sid, session_headers(s, admin), every.clone()).await.unwrap_err(), StatusCode::FORBIDDEN);
        }
        let later = now() + 9000.0;
        let moved = patch(&f, &f.sid, session_headers(s, "cat"), json!({"run_at": later})).await.unwrap();
        assert_eq!(moved["schedule"]["run_at"], later);
        assert_eq!(moved["schedule"]["is_owner"], false);
        assert_eq!(moved["schedule"]["can_manage"], true);
        let own = patch(&f, &f.sid, session_headers(s, "ana"), every).await.unwrap();
        assert_eq!(own["schedule"]["is_owner"], true);
    }

    #[tokio::test]
    async fn only_the_owner_brings_back_a_finished_schedule() {
        let f = fixture();
        let s = &f.state;
        let store = &s.hub.store;
        let done = ScheduleChange { status: Some("done".into()), ..Default::default() };
        store.update_schedule(&f.sid, &done, "ana", None).unwrap();
        let later = now() + 9000.0;
        // An admin moving a finished one-off's time would post as the owner
        // on demand.
        for admin in ["cat", "root"] {
            assert_eq!(patch(&f, &f.sid, session_headers(s, admin), json!({"run_at": later})).await.unwrap_err(), StatusCode::CONFLICT);
            assert_eq!(
                patch(&f, &f.sid, session_headers(s, admin), json!({"run_at": later, "status": "active"})).await.unwrap_err(),
                StatusCode::CONFLICT
            );
        }
        assert_eq!(store.schedule(&f.sid).unwrap()["status"], "done");
        // A paused one stays theirs to move or resume.
        let other = store.create_schedule("ana", &f.cid, None, "every", now() + 600.0,
            &json!({"kind": "interval", "seconds": 600}), "ana", None)["id"].as_str().unwrap().to_string();
        patch(&f, &other, session_headers(s, "cat"), json!({"status": "paused"})).await.unwrap();
        patch(&f, &other, session_headers(s, "cat"), json!({"run_at": later})).await.unwrap();
        let resumed = patch(&f, &other, session_headers(s, "cat"), json!({"status": "active"})).await.unwrap();
        assert_eq!(resumed["schedule"]["status"], "active");
        // The owner can.
        let back = patch(&f, &f.sid, session_headers(s, "ana"), json!({"run_at": later})).await.unwrap();
        assert_eq!(back["schedule"]["status"], "active");
    }

    #[tokio::test]
    async fn resuming_never_fires_a_slot_that_passed_while_paused() {
        let f = fixture();
        let s = &f.state;
        let store = &s.hub.store;
        let past = now() - 3.5 * 600.0;
        let every = store.create_schedule("ana", &f.cid, None, "every", past,
            &json!({"kind": "interval", "seconds": 600}), "ana", None)["id"].as_str().unwrap().to_string();
        let once = store.create_schedule("ana", &f.cid, None, "once", past,
            &json!({"kind": "once", "at": past}), "ana", None)["id"].as_str().unwrap().to_string();
        for id in [&every, &once] {
            patch(&f, id, session_headers(s, "ana"), json!({"status": "paused"})).await.unwrap();
        }
        let r = patch(&f, &every, session_headers(s, "ana"), json!({"status": "active"})).await.unwrap();
        assert!(r["schedule"]["run_at"].as_f64().unwrap() > now());
        assert_eq!(patch(&f, &once, session_headers(s, "ana"), json!({"status": "active"})).await.unwrap_err(), StatusCode::CONFLICT);
        let fresh = now() + 600.0;
        let r = patch(&f, &once, session_headers(s, "ana"), json!({"status": "active", "run_at": fresh})).await.unwrap();
        assert_eq!(r["schedule"]["run_at"], fresh);
    }

    #[tokio::test]
    async fn retiming_a_finished_schedule_counts_against_the_cap() {
        let f = fixture();
        let s = &f.state;
        let store = &s.hub.store;
        let done = store.create_schedule("ana", &f.cid, None, "done", now() + 60.0,
            &json!({"kind": "once", "at": now() + 60.0}), "ana", None)["id"].as_str().unwrap().to_string();
        store.update_schedule(&done, &ScheduleChange { status: Some("done".into()), ..Default::default() }, "ana", None);
        let live = store.count_live_schedules("ana");
        for i in live..crate::store::MAX_LIVE_PER_OWNER {
            store.create_schedule("ana", &f.cid, None, &format!("s{i}"), now() + 600.0,
                &json!({"kind": "once", "at": now() + 600.0}), "ana", None);
        }
        let r = patch(&f, &done, session_headers(s, "ana"), json!({"run_at": now() + 3600.0})).await;
        assert_eq!(r.unwrap_err(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn changes_notify_viewers_of_the_channel() {
        let f = fixture();
        let s = &f.state;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        s.hub.attach_socket("bob", false, tx);
        patch(&f, &f.sid, session_headers(s, "ana"), json!({"status": "paused"})).await.unwrap();
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev["type"], "schedules_changed");
        assert_eq!(ev["channel_id"], f.cid.as_str());
    }

    #[tokio::test]
    async fn retiming_rejects_past_times_and_keeps_a_one_offs_spec_in_step() {
        let f = fixture();
        let s = &f.state;
        // A past time (an admin could otherwise post as the owner on demand).
        let past = now() - 600.0;
        assert_eq!(
            patch(&f, &f.sid, admin_headers(s), json!({"run_at": past})).await.unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            patch(&f, &f.sid, session_headers(s, "ana"), json!({"schedule": {"kind": "once", "at": past}}))
                .await
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        // A new time moves the one-off's spec with it.
        let when = now() + 7200.0;
        let out = patch(&f, &f.sid, session_headers(s, "cat"), json!({"run_at": when})).await.unwrap();
        assert_eq!(out["schedule"]["run_at"], when);
        // `at` is read back from stored JSON text, which can differ from the
        // f64 in its last bit; run_at (a REAL column) round-trips exactly.
        assert!((out["schedule"]["schedule"]["at"].as_f64().unwrap() - when).abs() < 1e-3);
    }

    #[tokio::test]
    async fn resuming_or_retiming_rechecks_that_the_owner_can_still_post() {
        let f = fixture();
        let store = &f.state.hub.store;
        let paused = ScheduleChange { status: Some("paused".into()), ..Default::default() };
        store.update_schedule(&f.sid, &paused, "ana", None).unwrap();
        store.set_user_disabled("ana", true);
        // The owner can't act any more, but an admin managing it hits the re-check.
        let admin = admin_headers(&f.state);
        let resume = patch(&f, &f.sid, admin.clone(), json!({"status": "active"})).await;
        assert_eq!(resume.unwrap_err(), StatusCode::CONFLICT);
        let retime = patch(&f, &f.sid, admin.clone(), json!({"run_at": now() + 7200.0})).await;
        assert_eq!(retime.unwrap_err(), StatusCode::CONFLICT);
        // Pausing is never blocked by it.
        store.update_schedule(&f.sid, &ScheduleChange { status: Some("active".into()), ..Default::default() }, "ana", None);
        assert!(patch(&f, &f.sid, admin, json!({"status": "paused"})).await.is_ok());
    }

    #[tokio::test]
    async fn retiming_keeps_the_floor_after_the_last_post() {
        let f = fixture();
        let s = &f.state;
        let store = &s.hub.store;
        let at = now() - 1.0;
        let sid = store.create_schedule("ana", &f.cid, None, "tick", at,
            &json!({"kind": "interval", "seconds": 600}), "ana", None)["id"].as_str().unwrap().to_string();
        assert_eq!(s.hub.fire_due_schedules(now()), 1);
        // Seconds after a post, a hand-set next time would post again almost at once.
        let soon = patch(&f, &sid, session_headers(s, "ana"), json!({"run_at": now() + 60.0})).await;
        assert_eq!(soon.unwrap_err(), StatusCode::BAD_REQUEST);
        // Admins nudging it are held to the same floor.
        let nudge = patch(&f, &sid, session_headers(s, "cat"), json!({"run_at": now() + 60.0})).await;
        assert_eq!(nudge.unwrap_err(), StatusCode::BAD_REQUEST);
        let ok = patch(&f, &sid, session_headers(s, "ana"), json!({"run_at": now() + 400.0})).await.unwrap();
        assert_eq!(ok["schedule"]["status"], "active");
    }

    #[tokio::test]
    async fn resuming_an_active_overdue_schedule_is_a_no_op() {
        let f = fixture();
        let s = &f.state;
        let due = now() - 5.0;
        let sid = s.hub.store.create_schedule("ana", &f.cid, None, "due", due,
            &json!({"kind": "interval", "seconds": 600}), "ana", None)["id"].as_str().unwrap().to_string();
        let r = patch(&f, &sid, session_headers(s, "ana"), json!({"status": "active"})).await.unwrap();
        assert_eq!(r["schedule"]["run_at"], due, "the overdue slot must still post on the next tick");
        assert_eq!(s.hub.store.due_schedules(now(), 100).len(), 1);
    }

    #[tokio::test]
    async fn deleting_a_channel_tells_the_owner_its_schedules_are_gone() {
        let f = fixture();
        let s = &f.state;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        s.hub.attach_socket("ana", false, tx);
        s.hub.store.delete_channel(&f.cid);
        assert_eq!(s.hub.flush_schedule_cascades(), 1);
        let mut seen = false;
        while let Ok(ev) = rx.try_recv() {
            seen |= ev["type"] == "schedules_changed" && ev["channel_id"] == f.cid.as_str();
        }
        assert!(seen, "the owner's open lists refresh even though the channel is gone");
        assert_eq!(s.hub.flush_schedule_cascades(), 0, "drained once");
    }

    #[tokio::test]
    async fn an_owner_who_lost_the_channel_can_still_see_and_stop_their_schedule() {
        let f = fixture();
        let s = &f.state;
        let store = &s.hub.store;
        let gid = store.channel(&f.cid).unwrap()["group_id"].as_str().unwrap().to_string();
        store.remove_member_all(&gid, "user", "ana");
        // Still listed for the owner, flagged; others see it only with access.
        let mine = inbox(&f, session_headers(s, "ana")).await;
        let row = mine["items"].as_array().unwrap().iter().find(|i| i["id"] == f.sid.as_str()).cloned().unwrap();
        assert_eq!(row["channel_access"], false);
        assert_eq!(row["can_manage"], true);
        assert!(!inbox(&f, session_headers(s, "eve")).await["items"].as_array().unwrap().iter().any(|i| i["id"] == f.sid.as_str()));
        // Retiming into a channel they can't see is refused; pausing and cancelling work.
        let retime = patch(&f, &f.sid, session_headers(s, "ana"), json!({"run_at": now() + 7200.0})).await;
        assert_eq!(retime.unwrap_err(), StatusCode::FORBIDDEN);
        let resume_too = patch(&f, &f.sid, session_headers(s, "ana"), json!({"status": "active"})).await;
        assert_eq!(resume_too.unwrap_err(), StatusCode::FORBIDDEN);
        let paused = patch(&f, &f.sid, session_headers(s, "ana"), json!({"status": "paused"})).await.unwrap();
        assert_eq!(paused["schedule"]["status"], "paused");
        assert_eq!(paused["schedule"]["channel_access"], false);
        // Someone else without access still learns nothing.
        assert_eq!(cancel(&f, &f.sid, session_headers(s, "eve")).await, StatusCode::FORBIDDEN);
        assert_eq!(cancel(&f, &f.sid, session_headers(s, "ana")).await, StatusCode::OK);
        // Members who can see it get channel_access: true.
        let bob = channel_list(&f, &f.cid, session_headers(s, "bob")).await.unwrap();
        assert!(bob["items"].as_array().unwrap().iter().all(|i| i["channel_access"] == true));
    }

    fn drain_changes(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> usize {
        let mut n = 0;
        while let Ok(ev) = rx.try_recv() {
            n += usize::from(ev["type"] == "schedules_changed");
        }
        n
    }

    #[tokio::test]
    async fn an_owner_without_access_still_hears_about_their_own_changes() {
        let f = fixture();
        let s = &f.state;
        let gid = s.hub.store.channel(&f.cid).unwrap()["group_id"].as_str().unwrap().to_string();
        s.hub.store.remove_member_all(&gid, "user", "ana");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        s.hub.attach_socket("ana", false, tx);
        patch(&f, &f.sid, session_headers(s, "ana"), json!({"status": "paused"})).await.unwrap();
        assert_eq!(drain_changes(&mut rx), 1, "own pause reaches the owner's other devices");
        assert_eq!(cancel(&f, &f.sid, session_headers(s, "ana")).await, StatusCode::OK);
        assert_eq!(drain_changes(&mut rx), 1, "own cancel reaches them too");
    }

    #[tokio::test]
    async fn cancelling_twice_or_a_finished_schedule_is_refused() {
        let f = fixture();
        let s = &f.state;
        let ana = || session_headers(s, "ana");
        assert_eq!(cancel(&f, &f.sid, ana()).await, StatusCode::OK);
        assert_eq!(cancel(&f, &f.sid, ana()).await, StatusCode::CONFLICT);
        s.hub.store.update_schedule(&f.dm_sid, &ScheduleChange { status: Some("done".into()), ..Default::default() }, "ana", None);
        assert_eq!(cancel(&f, &f.dm_sid, ana()).await, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn null_text_is_absent_and_revivals_hit_the_hourly_limit() {
        let f = fixture();
        let s = &f.state;
        let store = &s.hub.store;
        let ana = || session_headers(s, "ana");
        let later = now() + 7200.0;
        let ok = patch(&f, &f.sid, ana(), json!({"text": null, "run_at": later})).await.unwrap();
        assert_eq!(ok["schedule"]["run_at"], later);
        // A finished one-off, with the hour's creations already used up.
        store.update_schedule(&f.sid, &ScheduleChange { status: Some("done".into()), ..Default::default() }, "ana", None);
        let at = now() + 3600.0;
        for _ in 0..crate::store::MAX_CREATES_PER_HOUR {
            let spec = json!({"kind": "once", "at": at});
            let id = store.create_schedule("ana", &f.cid, None, "filler", at, &spec, "ana", None)["id"]
                .as_str().unwrap().to_string();
            store.update_schedule(&id, &ScheduleChange { status: Some("done".into()), ..Default::default() }, "ana", None);
        }
        assert_eq!(
            patch(&f, &f.sid, ana(), json!({"run_at": later + 60.0})).await.unwrap_err(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }
}
