//! SQLite persistence for Agora: groups, channels, memberships, messages,
//! pins, stars, read markers, attachments, and the remembered-agents registry.
//!
//! Faithful port of Pantheo's `engine/agora/store.py` — payload shapes are
//! kept JSON-identical so the ported web UI works unchanged. Channel ids
//! double as chat ids in agent session keys, so they get a readable
//! `slug-hex` shape (`fitness-3f2a`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection, ErrorCode, OptionalExtension};
use serde_json::{json, Value};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at REAL NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    is_public INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'channel',
    dm_user_id TEXT,
    dm_agent_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_id);
CREATE TABLE IF NOT EXISTS memberships (
    group_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    member_type TEXT NOT NULL,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    added_at REAL NOT NULL,
    PRIMARY KEY (group_id, channel_id, member_type, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    thread_id INTEGER,
    author_type TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT,
    text TEXT NOT NULL,
    ts REAL NOT NULL,
    meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE TABLE IF NOT EXISTS pins (
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_by TEXT,
    pinned_at REAL NOT NULL,
    PRIMARY KEY (channel_id, message_id)
);
CREATE TABLE IF NOT EXISTS stars (
    username TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    starred_at REAL NOT NULL,
    PRIMARY KEY (username, message_id)
);
CREATE INDEX IF NOT EXISTS idx_stars_user_channel ON stars(username, channel_id);
-- Emoji reactions: one row per (message, user, emoji). Aggregated onto
-- message payloads as [{emoji, users: [...]}] in first-reaction order, so
-- clients derive counts and their own "reacted" state from the user list.
CREATE TABLE IF NOT EXISTS reactions (
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    reacted_at REAL NOT NULL,
    reactor_type TEXT NOT NULL DEFAULT 'user',
    reactor_id TEXT NOT NULL DEFAULT '',
    -- Keep the legacy key for an additive migration. A same-named user and
    -- agent still cannot share one emoji reaction; typed identity prevents
    -- display/mine/delete collisions without rebuilding existing databases.
    PRIMARY KEY (message_id, username, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE TABLE IF NOT EXISTS reads (
    username TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    PRIMARY KEY (username, channel_id)
);
-- Per-thread read markers (threads have their own unread state; channel
-- badges only count top-level messages).
CREATE TABLE IF NOT EXISTS thread_reads (
    username TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    PRIMARY KEY (username, thread_id)
);
-- Threads dismissed from the user's inbox/sidebar. The messages stay in the
-- channel; the thread just stops surfacing in `my_threads`.
CREATE TABLE IF NOT EXISTS thread_hides (
    username TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    hidden_at REAL NOT NULL,
    PRIMARY KEY (username, thread_id)
);
-- One row per user @mentioned by a message; drives mention-aware badges.
CREATE TABLE IF NOT EXISTS mentions (
    message_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (message_id, username)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user_channel ON mentions(username, channel_id, message_id);
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id);
CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel_id);
-- Agents the app has seen from any connection (dial-out hello or dial-in
-- pairing). Memberships reference these ids; persisting them means the
-- member picker and channel rosters survive restarts while agents are
-- offline. `source` is the connection name the agent last appeared on.
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    requires_mention INTEGER NOT NULL DEFAULT 0,
    last_seen REAL NOT NULL,
    -- Whether the agent's home instance offers a profile picture, plus a
    -- cache-busting stamp (file mtime there); the bytes are proxied on demand.
    has_avatar INTEGER NOT NULL DEFAULT 0,
    avatar_v INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_dm_policies (
    agent_id TEXT PRIMARY KEY,
    is_public INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_dm_grants (
    agent_id TEXT NOT NULL,
    username TEXT NOT NULL,
    granted_at REAL NOT NULL,
    PRIMARY KEY (agent_id, username)
);
-- Expo push tokens from mobile clients (APNs/FCM via Expo), owned by the
-- account that registered them so pushes follow channel visibility.
-- Sign-out / DeviceNotRegistered prune rows. `username` is '' only for rows
-- written before accounts existed; the boot migration claims those for the
-- migrated admin.
CREATE TABLE IF NOT EXISTS push_tokens (
    token TEXT PRIMARY KEY,
    platform TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL
);
-- Workspace accounts. `username` is the stable key every other per-user
-- table (reads, stars, memberships, message authorship, mentions) already
-- uses, so accounts bolt onto existing state without a rekey.
-- `session_version` is embedded in minted session tokens; bumping it
-- revokes that user's sessions without signing everyone else out.
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT UNIQUE,
    instance_role TEXT NOT NULL DEFAULT 'member',
    created_at REAL NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1
);
-- Pending email invites: signing in (Google/Apple) with a matching verified
-- email creates the account. Accepted rows are kept for provenance.
CREATE TABLE IF NOT EXISTS invites (
    email TEXT PRIMARY KEY,
    invited_by TEXT,
    instance_role TEXT NOT NULL DEFAULT 'member',
    created_at REAL NOT NULL,
    accepted_at REAL
);
-- Shareable invite links: single-use, expiring tokens that admit whichever
-- verified email signs in with them. Used rows are kept for provenance.
CREATE TABLE IF NOT EXISTS invite_links (
    token TEXT PRIMARY KEY,
    invited_by TEXT,
    instance_role TEXT NOT NULL DEFAULT 'member',
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used_by TEXT,
    used_at REAL
);
-- Per-user presentation state for the sidebar: hiding and ordering are
-- personal (like Slack's sidebar), never shared. The legacy global
-- `hidden`/`position` columns on groups/channels stop being written once
-- this exists; the boot migration copies them in for the migrated admin.
CREATE TABLE IF NOT EXISTS user_prefs (
    username TEXT NOT NULL,
    kind TEXT NOT NULL,           -- 'group' | 'channel'
    item_id TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    position INTEGER,             -- NULL = no manual order for this item
    PRIMARY KEY (username, kind, item_id)
);
-- Private reusable message drafts. Membership removal deliberately keeps
-- these rows so rejoining the group restores the user's templates.
CREATE TABLE IF NOT EXISTS message_templates (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    group_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_templates_owner
    ON message_templates(username, group_id, created_at, id);
-- Fetched link-preview metadata (see unfurl.rs), keyed by exact URL: one
-- fetch per URL across all messages. Failures are cached too (ok = 0) so a
-- dead link is not retried per message; rows expire by fetched_at against
-- UNFURL_TTL_OK / UNFURL_TTL_ERR.
CREATE TABLE IF NOT EXISTS unfurl_cache (
    url TEXT PRIMARY KEY,
    ok INTEGER NOT NULL,
    meta TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
-- Full-text index over message text (external content: rows live in
-- `messages`, the index holds only tokens). Porter stemming so "deploy"
-- finds "deployed"/"deployment". Kept in sync by the triggers below;
-- migrate() rebuilds it when it drifts (e.g. a database that predates it).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='id',
    tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
"#;

/// How long a successful unfurl row stays fresh (page metadata is stable).
pub const UNFURL_TTL_OK: f64 = 7.0 * 86_400.0;
/// Failures retry sooner — the page may have been down, not gone.
pub const UNFURL_TTL_ERR: f64 = 86_400.0;

/// Columns added after v1 shipped: CREATE TABLE IF NOT EXISTS won't alter
/// existing tables, so bolt them on when missing.
fn migrate(conn: &Connection) {
    let has_column = |table: &str, column: &str| -> bool {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
        let found = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .any(|c| c == column);
        found
    };
    for table in ["groups", "channels"] {
        if !has_column(table, "position") {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN position INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .unwrap();
        }
        // Hidden = tucked away in the sidebar, not deleted.
        if !has_column(table, "hidden") {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .unwrap();
        }
    }
    if !has_column("channels", "kind") {
        conn.execute("ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel'", []).unwrap();
    }
    if !has_column("channels", "dm_user_id") {
        conn.execute("ALTER TABLE channels ADD COLUMN dm_user_id TEXT", []).unwrap();
    }
    if !has_column("channels", "dm_agent_id") {
        conn.execute("ALTER TABLE channels ADD COLUMN dm_agent_id TEXT", []).unwrap();
    }
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_dm_pair ON channels(dm_user_id, dm_agent_id) WHERE kind = 'agent_dm'",
        [],
    ).unwrap();
    // Public groups: every signed-in user gets member-level access without a
    // membership row.
    if !has_column("groups", "is_public") {
        conn.execute(
            "ALTER TABLE groups ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .unwrap();
    }
    for column in ["has_avatar", "avatar_v"] {
        if !has_column("agents", column) {
            conn.execute(
                &format!("ALTER TABLE agents ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .unwrap();
        }
    }
    if !has_column("messages", "meta") {
        conn.execute("ALTER TABLE messages ADD COLUMN meta TEXT", []).unwrap();
    }
    // Push tokens gained an owner when accounts landed; pre-account rows
    // start unowned ('') and are claimed by the boot migration.
    if !has_column("push_tokens", "username") {
        conn.execute(
            "ALTER TABLE push_tokens ADD COLUMN username TEXT NOT NULL DEFAULT ''",
            [],
        )
        .unwrap();
    }
    // A user-chosen display name for a thread; only meaningful on root rows
    // (thread_id IS NULL). NULL = fall back to the root message's first line.
    if !has_column("messages", "thread_alias") {
        conn.execute("ALTER TABLE messages ADD COLUMN thread_alias TEXT", []).unwrap();
    }
    if !has_column("reactions", "reactor_type") {
        conn.execute("ALTER TABLE reactions ADD COLUMN reactor_type TEXT NOT NULL DEFAULT 'user'", []).unwrap();
    }
    if !has_column("reactions", "reactor_id") {
        conn.execute("ALTER TABLE reactions ADD COLUMN reactor_id TEXT NOT NULL DEFAULT ''", []).unwrap();
        conn.execute("UPDATE reactions SET reactor_id = username", []).unwrap();
        conn.execute("UPDATE reactions SET reactor_type = 'agent', reactor_id = \
            (SELECT id FROM agents WHERE agents.name = reactions.username) \
            WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.username = reactions.username) \
            AND (SELECT COUNT(*) FROM agents WHERE agents.name = reactions.username) = 1", []).unwrap();
    }
    // Databases that predate the FTS index get it created empty by SCHEMA —
    // the triggers only cover writes from then on, so the existing history
    // needs a one-time backfill. Row counts can't detect this (a bare scan of
    // an external-content FTS table reads through to `messages`, so the
    // counts always agree even when the index is empty); use the schema
    // version marker instead.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version < 1 {
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')", [])
            .unwrap();
        conn.execute("PRAGMA user_version = 1", []).unwrap();
    }
}

pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

pub fn slugify(name: &str) -> String {
    let lowered = name.to_lowercase();
    let mapped: String = lowered
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    mapped
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn new_id(name: &str) -> String {
    let slug: String = slugify(name).chars().take(32).collect();
    let n: u16 = rand::random();
    format!("{}-{:04x}", slug, n)
}

pub fn new_token() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Build a safe FTS5 MATCH expression from raw user input. Double-quoted runs
/// stay exact phrases; bare words become quoted terms with the last one a
/// prefix (`"agor"*`) so search-as-you-type works. Quoting every term means
/// user input can never be parsed as FTS5 syntax (`AND`, `-`, `:` …), so an
/// arbitrary query string can't error the index.
pub fn fts_query(raw: &str) -> Option<String> {
    let mut terms: Vec<(String, bool)> = Vec::new(); // (term, is_phrase)
    let mut cur = String::new();
    let mut in_phrase = false;
    let flush = |cur: &mut String, terms: &mut Vec<(String, bool)>, phrase: bool| {
        let t: String = cur.chars().filter(|c| *c != '"').collect();
        if !t.trim().is_empty() {
            terms.push((t.trim().to_string(), phrase));
        }
        cur.clear();
    };
    for ch in raw.chars() {
        match ch {
            '"' => {
                flush(&mut cur, &mut terms, in_phrase);
                in_phrase = !in_phrase;
            }
            c if c.is_whitespace() && !in_phrase => flush(&mut cur, &mut terms, false),
            c => cur.push(c),
        }
    }
    flush(&mut cur, &mut terms, in_phrase);
    if terms.is_empty() {
        return None;
    }
    let last = terms.len() - 1;
    Some(
        terms
            .iter()
            .enumerate()
            .map(|(i, (t, phrase))| {
                if !phrase && i == last {
                    format!("\"{t}\"*")
                } else {
                    format!("\"{t}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// OR-of-terms MATCH expression for recall-oriented retrieval (AI answers):
/// every word matches independently, bm25 ranks messages hitting more of
/// them higher. Same quoting rule as [`fts_query`], so input is never syntax.
pub fn fts_query_any(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .map(|w| w.chars().filter(|c| *c != '"').collect::<String>())
        .filter(|w| !w.trim().is_empty())
        .map(|w| format!("\"{}\"", w.trim()))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

/// SQL predicate selecting one attachment *kind*, or
/// `None` for an unknown value (which means "any attachment"). Keeps the mime
/// buckets the search UIs expose in one place.
fn file_kind_predicate(kind: &str, alias: &str) -> Option<String> {
    Some(match kind {
        "image" => format!("{alias}.mime LIKE 'image/%'"),
        "video" => format!("{alias}.mime LIKE 'video/%'"),
        "audio" => format!("{alias}.mime LIKE 'audio/%'"),
        "pdf" => format!("{alias}.mime = 'application/pdf'"),
        // Everything a person would call a "document".
        "doc" => format!("({alias}.mime = 'application/pdf' OR {alias}.mime LIKE 'application/vnd.%' \
                   OR {alias}.mime LIKE 'application/msword%' OR {alias}.mime LIKE 'text/%')"),
        _ => return None,
    })
}

/// `%…%` LIKE pattern with the wildcards in the user's input neutralized.
fn like_pattern(raw: &str) -> String {
    let escaped: String = raw
        .chars()
        .flat_map(|c| match c {
            '\\' | '%' | '_' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    format!("%{escaped}%")
}

fn message_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Value> {
    let meta_raw: Option<String> = row.get(offset + 8)?;
    let meta = meta_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(Value::Null);
    Ok(json!({
        "id": row.get::<_, i64>(offset)?,
        "channel_id": row.get::<_, String>(offset + 1)?,
        "thread_id": row.get::<_, Option<i64>>(offset + 2)?,
        "author_type": row.get::<_, String>(offset + 3)?,
        "author_id": row.get::<_, String>(offset + 4)?,
        "author_name": row.get::<_, Option<String>>(offset + 5)?,
        "text": row.get::<_, String>(offset + 6)?,
        "ts": row.get::<_, f64>(offset + 7)?,
        "meta": meta,
    }))
}

const MSG_COLS: &str =
    "id, channel_id, thread_id, author_type, author_id, author_name, text, ts, meta";

const USER_COLS: &str =
    "username, display_name, email, instance_role, created_at, disabled, session_version";

fn user_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "username": row.get::<_, String>(0)?,
        "display_name": row.get::<_, String>(1)?,
        "email": row.get::<_, Option<String>>(2)?,
        "instance_role": row.get::<_, String>(3)?,
        "created_at": row.get::<_, f64>(4)?,
        "disabled": row.get::<_, i64>(5)? != 0,
        "session_version": row.get::<_, i64>(6)?,
    }))
}

/// An uploaded attachment on its way into `add_message`.
pub struct NewAttachment {
    pub filename: String,
    pub mime: String,
    pub data: Vec<u8>,
}

pub struct Store {
    conn: Mutex<Connection>,
    pub files_dir: PathBuf,
}

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // WAL + synchronous=NORMAL: commits stop paying a full journal fsync,
        // which on network-attached volumes (Railway) can stall for seconds
        // while every other request queues behind the connection mutex.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            files_dir: path.parent().unwrap_or(Path::new(".")).join("agora_files"),
        })
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            files_dir: std::env::temp_dir().join("agora_files_test"),
        })
    }

    /// Consistent snapshot of the live database into `dest` (SQLite online
    /// backup — safe while the server keeps writing).
    pub fn backup_to(&self, dest: &Path) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let mut dst = Connection::open(dest)?;
        let backup = rusqlite::backup::Backup::new(&conn, &mut dst)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(2), None)?;
        Ok(())
    }

    /// Row counts for the export manifest.
    pub fn counts(&self) -> Value {
        let conn = self.conn.lock().unwrap();
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap_or(0)
        };
        json!({
            "groups": count("groups"),
            "channels": count("channels"),
            "messages": count("messages"),
            "files": count("files"),
        })
    }

    // ------------------------------------------------------------- groups

    pub fn create_group(&self, name: &str, description: &str, created_by: Option<&str>) -> Value {
        let gid = new_id(name);
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO groups (id, name, description, created_by, created_at, position) \
                 VALUES (?1, ?2, ?3, ?4, ?5, \
                   (SELECT COALESCE(MAX(position), 0) + 1 FROM groups))",
                params![gid, name, description, created_by, now()],
            )
            .unwrap();
            if let Some(user) = created_by {
                insert_member(&conn, &gid, None, "user", user, "admin");
            }
        }
        self.group(&gid).unwrap_or(Value::Null)
    }

    pub fn group(&self, group_id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, description, created_by, created_at, hidden, is_public FROM groups WHERE id = ?1",
            params![group_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                    "description": r.get::<_, String>(2)?,
                    "created_by": r.get::<_, Option<String>>(3)?,
                    "created_at": r.get::<_, f64>(4)?,
                    "hidden": r.get::<_, i64>(5)? != 0,
                    "is_public": r.get::<_, i64>(6)? != 0,
                }))
            },
        )
        .ok()
    }

    pub fn list_groups(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, created_by, created_at, hidden, is_public FROM groups ORDER BY position, name",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "created_by": r.get::<_, Option<String>>(3)?,
                "created_at": r.get::<_, f64>(4)?,
                "hidden": r.get::<_, i64>(5)? != 0,
                "is_public": r.get::<_, i64>(6)? != 0,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// Tuck a group away in (or restore it to) the sidebar. Purely
    /// presentational — members, messages, and agent fan-out are untouched.
    pub fn set_group_hidden(&self, group_id: &str, hidden: bool) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            let changed = conn
                .execute(
                    "UPDATE groups SET hidden = ?1 WHERE id = ?2",
                    params![hidden as i64, group_id],
                )
                .unwrap();
            if changed == 0 {
                return None;
            }
        }
        self.group(group_id)
    }

    /// Open a group to every signed-in user (or make it members-only again).
    /// Access-level change only — membership rows and group-admin roles are
    /// untouched.
    pub fn set_group_public(&self, group_id: &str, is_public: bool) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            let changed = conn
                .execute(
                    "UPDATE groups SET is_public = ?1 WHERE id = ?2",
                    params![is_public as i64, group_id],
                )
                .unwrap();
            if changed == 0 {
                return None;
            }
        }
        self.group(group_id)
    }

    pub fn delete_group(&self, group_id: &str) -> bool {
        let file_ids;
        let deleted;
        {
            let conn = self.conn.lock().unwrap();
            let channel_ids: Vec<String> = {
                let mut stmt = conn
                    .prepare("SELECT id FROM channels WHERE group_id = ?1")
                    .unwrap();
                stmt.query_map(params![group_id], |r| r.get::<_, String>(0))
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect()
            };
            deleted = conn
                .execute("DELETE FROM groups WHERE id = ?1", params![group_id])
                .unwrap()
                > 0;
            conn.execute("DELETE FROM channels WHERE group_id = ?1", params![group_id]).unwrap();
            conn.execute("DELETE FROM memberships WHERE group_id = ?1", params![group_id]).unwrap();
            conn.execute("DELETE FROM message_templates WHERE group_id = ?1", params![group_id]).unwrap();
            file_ids = if channel_ids.is_empty() {
                Vec::new()
            } else {
                let placeholders = vec!["?"; channel_ids.len()].join(",");
                let ids: Vec<String> = {
                    let mut stmt = conn
                        .prepare(&format!("SELECT id FROM files WHERE channel_id IN ({placeholders})"))
                        .unwrap();
                    stmt.query_map(params_from_iter(channel_ids.iter()), |r| r.get::<_, String>(0))
                        .unwrap()
                        .filter_map(Result::ok)
                        .collect()
                };
                for cid in &channel_ids {
                    delete_thread_reads_for_channel(&conn, cid);
                }
                for table in
                    ["messages", "pins", "stars", "reactions", "files", "reads", "mentions"]
                {
                    conn.execute(
                        &format!("DELETE FROM {table} WHERE channel_id IN ({placeholders})"),
                        params_from_iter(channel_ids.iter()),
                    )
                    .unwrap();
                }
                ids
            };
        }
        self.unlink_files(&file_ids);
        deleted
    }

    // ----------------------------------------------------- message templates

    /// Oldest first: the picker's order must not shuffle when a template is
    /// edited, so it keys off creation, never `updated_at`.
    pub fn message_templates(&self, username: &str, group_id: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, label, text, created_at, updated_at FROM message_templates \
                 WHERE username = ?1 AND group_id = ?2 ORDER BY created_at ASC, id ASC",
            )
            .unwrap();
        stmt.query_map(params![username, group_id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "group_id": group_id,
                "label": r.get::<_, String>(1)?,
                "text": r.get::<_, String>(2)?,
                "created_at": r.get::<_, f64>(3)?,
                "updated_at": r.get::<_, f64>(4)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn create_message_template(
        &self,
        username: &str,
        group_id: &str,
        label: &str,
        text: &str,
        max_count: i64,
    ) -> Result<Option<Value>, rusqlite::Error> {
        // Labels are free text, so they can slugify to nothing (emoji-only);
        // fall back so the id never degenerates to a bare random suffix.
        let seed = if slugify(label).is_empty() { "template" } else { label };
        let ts = now();
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM message_templates WHERE username = ?1 AND group_id = ?2",
            params![username, group_id],
            |r| r.get(0),
        )?;
        if count >= max_count {
            return Ok(None);
        }
        // Human labels repeat heavily and new_id has a short random suffix.
        // Retry the only expected constraint failure instead of dropping the
        // HTTP connection on an unlucky id collision.
        let mut inserted = None;
        for _ in 0..3 {
            let id = new_id(seed);
            match conn.execute(
                "INSERT INTO message_templates \
                 (id, username, group_id, label, text, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![id, username, group_id, label, text, ts],
            ) {
                Ok(_) => {
                    inserted = Some(id);
                    break;
                }
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.code == ErrorCode::ConstraintViolation => continue,
                Err(e) => return Err(e),
            }
        }
        let Some(id) = inserted else {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                Some("message template id collided after three attempts".into()),
            ));
        };
        Ok(Some(json!({"id": id, "group_id": group_id, "label": label, "text": text,
               "created_at": ts, "updated_at": ts})))
    }

    /// `None` when the row is not this user's template in this group — the
    /// owner check lives in the WHERE clause, so a mismatch is a plain miss.
    pub fn update_message_template(
        &self,
        id: &str,
        username: &str,
        group_id: &str,
        label: &str,
        text: &str,
    ) -> Option<Value> {
        let ts = now();
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
                "UPDATE message_templates SET label = ?4, text = ?5, updated_at = ?6 \
                 WHERE id = ?1 AND username = ?2 AND group_id = ?3",
                params![id, username, group_id, label, text, ts],
            )
            .unwrap()
            > 0;
        if !changed {
            return None;
        }
        conn.query_row(
            "SELECT created_at FROM message_templates \
             WHERE id = ?1 AND username = ?2 AND group_id = ?3",
            params![id, username, group_id],
            |r| r.get::<_, f64>(0),
        )
        .ok()
        .map(|created_at| json!({
            "id": id, "group_id": group_id, "label": label, "text": text,
            "created_at": created_at, "updated_at": ts,
        }))
    }

    pub fn delete_message_template(&self, id: &str, username: &str, group_id: &str) -> bool {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "DELETE FROM message_templates WHERE id = ?1 AND username = ?2 AND group_id = ?3",
                params![id, username, group_id],
            )
            .unwrap()
            > 0
    }

    pub fn message_template_label(
        &self,
        id: &str,
        username: &str,
        group_id: &str,
    ) -> Option<String> {
        self.conn.lock().unwrap().query_row(
            "SELECT label FROM message_templates WHERE id = ?1 AND username = ?2 AND group_id = ?3",
            params![id, username, group_id],
            |r| r.get(0),
        ).ok()
    }

    // ------------------------------------------------------------- channels

    pub fn create_channel(&self, group_id: &str, name: &str, topic: &str) -> Value {
        let cid = new_id(name);
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO channels (id, group_id, name, topic, created_at, position) \
                 VALUES (?1, ?2, ?3, ?4, ?5, \
                   (SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE group_id = ?2))",
                params![cid, group_id, name, topic, now()],
            )
            .unwrap();
        }
        self.channel(&cid).unwrap_or(Value::Null)
    }

    /// Rename a channel, set its topic, and/or toggle its hidden flag
    /// (None = leave unchanged).
    pub fn update_channel(
        &self,
        channel_id: &str,
        name: Option<&str>,
        topic: Option<&str>,
        hidden: Option<bool>,
    ) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            if let Some(n) = name {
                conn.execute(
                    "UPDATE channels SET name = ?1 WHERE id = ?2",
                    params![n, channel_id],
                )
                .unwrap();
            }
            if let Some(t) = topic {
                conn.execute(
                    "UPDATE channels SET topic = ?1 WHERE id = ?2",
                    params![t, channel_id],
                )
                .unwrap();
            }
            if let Some(h) = hidden {
                conn.execute(
                    "UPDATE channels SET hidden = ?1 WHERE id = ?2",
                    params![h as i64, channel_id],
                )
                .unwrap();
            }
        }
        self.channel(channel_id)
    }

    /// Give a thread a display alias (Some = set, None = clear back to the
    /// root message's first line). Returns the updated root message, or None
    /// if `thread_id` isn't a real thread root (a top-level message).
    pub fn rename_thread(&self, thread_id: i64, alias: Option<&str>) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            let is_root = conn
                .query_row(
                    "SELECT 1 FROM messages WHERE id = ?1 AND thread_id IS NULL",
                    params![thread_id],
                    |_| Ok(()),
                )
                .is_ok();
            if !is_root {
                return None;
            }
            conn.execute(
                "UPDATE messages SET thread_alias = ?1 WHERE id = ?2",
                params![alias, thread_id],
            )
            .unwrap();
        }
        self.message(thread_id)
    }

    /// Persist a manual order: each id's position becomes its array index.
    /// Ids not listed keep their old position (they sort after by name).
    pub fn reorder_groups(&self, ids: &[String]) {
        let conn = self.conn.lock().unwrap();
        for (i, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE groups SET position = ?1 WHERE id = ?2",
                params![i as i64 + 1, id],
            )
            .unwrap();
        }
    }

    pub fn reorder_channels(&self, group_id: &str, ids: &[String]) {
        let conn = self.conn.lock().unwrap();
        for (i, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE channels SET position = ?1 WHERE id = ?2 AND group_id = ?3",
                params![i as i64 + 1, id, group_id],
            )
            .unwrap();
        }
    }

    // ------------------------------------------------------------- user prefs

    /// One user's sidebar prefs for a kind ('group'/'channel'):
    /// item_id -> (hidden, manual position).
    pub fn user_prefs(&self, username: &str, kind: &str) -> HashMap<String, (bool, Option<i64>)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT item_id, hidden, position FROM user_prefs \
                 WHERE username = ?1 AND kind = ?2",
            )
            .unwrap();
        stmt.query_map(params![username, kind], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, i64>(1)? != 0, r.get::<_, Option<i64>>(2)?),
            ))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// Hide (or restore) one group/channel for one user. Purely personal
    /// presentation — everyone else's sidebar is untouched.
    pub fn set_pref_hidden(&self, username: &str, kind: &str, item_id: &str, hidden: bool) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO user_prefs (username, kind, item_id, hidden) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(username, kind, item_id) DO UPDATE SET hidden = excluded.hidden",
            params![username, kind, item_id, hidden as i64],
        )
        .unwrap();
    }

    /// Persist one user's manual order: each id's position becomes its array
    /// index. Items without a position sort after, by name.
    pub fn set_pref_positions(&self, username: &str, kind: &str, ids: &[String]) {
        let conn = self.conn.lock().unwrap();
        for (i, id) in ids.iter().enumerate() {
            conn.execute(
                "INSERT INTO user_prefs (username, kind, item_id, position) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(username, kind, item_id) DO UPDATE SET position = excluded.position",
                params![username, kind, id, i as i64 + 1],
            )
            .unwrap();
        }
    }

    /// One-time copy of the legacy instance-global `hidden`/`position`
    /// columns into per-user pref rows for `username` (the migrated
    /// single-user admin). No-op once the user has any pref rows, so it is
    /// safe to call on every boot.
    pub fn seed_prefs_from_globals(&self, username: &str) {
        let conn = self.conn.lock().unwrap();
        let has_prefs = conn
            .query_row(
                "SELECT 1 FROM user_prefs WHERE username = ?1 LIMIT 1",
                params![username],
                |_| Ok(()),
            )
            .is_ok();
        if has_prefs {
            return;
        }
        conn.execute(
            "INSERT INTO user_prefs (username, kind, item_id, hidden, position) \
             SELECT ?1, 'group', id, hidden, NULLIF(position, 0) FROM groups \
             WHERE hidden != 0 OR position != 0",
            params![username],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO user_prefs (username, kind, item_id, hidden, position) \
             SELECT ?1, 'channel', id, hidden, NULLIF(position, 0) FROM channels \
             WHERE hidden != 0 OR position != 0",
            params![username],
        )
        .unwrap();
    }

    pub fn channel(&self, channel_id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, group_id, name, topic, created_at, hidden, kind, dm_user_id, dm_agent_id FROM channels WHERE id = ?1",
            params![channel_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "group_id": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?, "topic": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, f64>(4)?,
                    "hidden": r.get::<_, i64>(5)? != 0,
                    "kind": r.get::<_, String>(6)?,
                    "dm_user_id": r.get::<_, Option<String>>(7)?,
                    "dm_agent_id": r.get::<_, Option<String>>(8)?,
                }))
            },
        )
        .ok()
    }

    pub fn group_channels(&self, group_id: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, group_id, name, topic, created_at, hidden FROM channels \
                 WHERE group_id = ?1 ORDER BY position, name",
            )
            .unwrap();
        stmt.query_map(params![group_id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "group_id": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?, "topic": r.get::<_, String>(3)?,
                "created_at": r.get::<_, f64>(4)?,
                "hidden": r.get::<_, i64>(5)? != 0,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn open_agent_dm(&self, username: &str, agent_id: &str, agent_name: &str) -> Value {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO channels (id, group_id, name, topic, created_at, kind, dm_user_id, dm_agent_id) \
             VALUES (?1, '', ?2, '', ?3, 'agent_dm', ?4, ?5) \
             ON CONFLICT(dm_user_id, dm_agent_id) WHERE kind = 'agent_dm' DO NOTHING",
            params![new_id(agent_name), agent_name, now(), username, agent_id],
        ).unwrap();
        let id: String = conn.query_row(
            "SELECT id FROM channels WHERE kind = 'agent_dm' AND dm_user_id = ?1 AND dm_agent_id = ?2",
            params![username, agent_id], |r| r.get(0),
        ).unwrap();
        drop(conn);
        self.channel(&id).unwrap_or(Value::Null)
    }

    pub fn agent_dms_for_user(&self, username: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.dm_agent_id, a.name, a.last_seen, \
                    COALESCE((SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.thread_id IS NULL \
                      AND m.id > COALESCE((SELECT last_read_id FROM reads WHERE username = ?1 AND channel_id = c.id), 0) \
                      AND NOT (m.author_type = 'user' AND m.author_id = ?1)), 0) \
             FROM channels c LEFT JOIN agents a ON a.id = c.dm_agent_id \
             WHERE c.kind = 'agent_dm' AND c.dm_user_id = ?1 ORDER BY a.name"
        ).unwrap();
        stmt.query_map(params![username], |r| Ok(json!({
            "channel_id": r.get::<_, String>(0)?, "agent_id": r.get::<_, String>(1)?,
            "agent_name": r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "Unknown agent".into()),
            "last_seen": r.get::<_, Option<f64>>(3)?.unwrap_or(0.0), "unread": r.get::<_, i64>(4)?,
        }))).unwrap().filter_map(Result::ok).collect()
    }

    pub fn agent_dm_policy(&self, agent_id: &str) -> Value {
        let conn = self.conn.lock().unwrap();
        let public = conn.query_row("SELECT is_public FROM agent_dm_policies WHERE agent_id = ?1",
            params![agent_id], |r| r.get::<_, i64>(0)).unwrap_or(0) != 0;
        let mut stmt = conn.prepare("SELECT username FROM agent_dm_grants WHERE agent_id = ?1 ORDER BY username").unwrap();
        let grants: Vec<String> = stmt.query_map(params![agent_id], |r| r.get(0)).unwrap().filter_map(Result::ok).collect();
        json!({"agent_id": agent_id, "is_public": public, "grants": grants})
    }

    pub fn set_agent_dm_policy(&self, agent_id: &str, public: bool, grants: &[String]) {
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT INTO agent_dm_policies(agent_id, is_public, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(agent_id) DO UPDATE SET is_public=excluded.is_public, updated_at=excluded.updated_at",
            params![agent_id, public as i64, now()]).unwrap();
        conn.execute("DELETE FROM agent_dm_grants WHERE agent_id = ?1", params![agent_id]).unwrap();
        for user in grants {
            conn.execute("INSERT INTO agent_dm_grants(agent_id, username, granted_at) \
                 SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM users WHERE username = ?2 AND disabled = 0)",
                params![agent_id, user, now()]).unwrap();
        }
    }

    pub fn user_can_start_agent_dm(&self, username: &str, agent_id: &str) -> bool {
        self.conn.lock().unwrap().query_row(
            "SELECT 1 FROM agents a JOIN users u ON u.username = ?1 AND u.disabled = 0 WHERE a.id = ?2 AND ( \
               u.instance_role = 'admin' OR \
               EXISTS (SELECT 1 FROM agent_dm_policies p WHERE p.agent_id = a.id AND p.is_public = 1) OR \
               EXISTS (SELECT 1 FROM agent_dm_grants g WHERE g.agent_id = a.id AND g.username = ?1)) LIMIT 1",
            params![username, agent_id], |_| Ok(())).is_ok()
    }

    pub fn user_owns_agent_dm(&self, username: &str, channel_id: &str) -> bool {
        self.conn.lock().unwrap().query_row(
            "SELECT 1 FROM channels WHERE id = ?1 AND kind = 'agent_dm' AND dm_user_id = ?2",
            params![channel_id, username], |_| Ok(())).is_ok()
    }

    pub fn agent_dm_route_allowed(&self, channel_id: &str, agent_id: &str) -> bool {
        let Some(channel) = self.channel(channel_id) else { return false };
        if channel["kind"] != "agent_dm" { return true; }
        channel["dm_agent_id"].as_str() == Some(agent_id)
            && channel["dm_user_id"].as_str().is_some_and(|user| self.user_can_start_agent_dm(user, agent_id))
    }

    pub fn delete_channel(&self, channel_id: &str) -> bool {
        let file_ids: Vec<String>;
        let deleted;
        {
            let conn = self.conn.lock().unwrap();
            file_ids = {
                let mut stmt = conn
                    .prepare("SELECT id FROM files WHERE channel_id = ?1")
                    .unwrap();
                stmt.query_map(params![channel_id], |r| r.get::<_, String>(0))
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect()
            };
            deleted = conn
                .execute("DELETE FROM channels WHERE id = ?1", params![channel_id])
                .unwrap()
                > 0;
            delete_thread_reads_for_channel(&conn, channel_id);
            for table in
                ["messages", "memberships", "pins", "stars", "reactions", "files", "reads", "mentions"]
            {
                conn.execute(
                    &format!("DELETE FROM {table} WHERE channel_id = ?1"),
                    params![channel_id],
                )
                .unwrap();
            }
        }
        self.unlink_files(&file_ids);
        deleted
    }

    /// Erase everything keyed to a user, for account deletion: authored
    /// messages (threads they started go whole — replies pointing at a
    /// deleted root would dangle) with their attachments, plus stars, read
    /// markers, hidden threads, mentions, pins and memberships. Groups they
    /// created stay (they are shared spaces), only the `created_by`
    /// provenance is cleared.
    pub fn delete_user_data(&self, username: &str) {
        let dm_channels: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT id FROM channels WHERE kind = 'agent_dm' AND dm_user_id = ?1").unwrap();
            stmt.query_map(params![username], |r| r.get(0)).unwrap().filter_map(Result::ok).collect()
        };
        let file_ids: Vec<String>;
        {
            let conn = self.conn.lock().unwrap();
            let message_ids: Vec<i64> = {
                let mut stmt = conn
                    .prepare(
                        "SELECT id FROM messages WHERE (author_type = 'user' AND author_id = ?1) \
                           OR thread_id IN (SELECT id FROM messages \
                                            WHERE author_type = 'user' AND author_id = ?1)",
                    )
                    .unwrap();
                stmt.query_map(params![username], |r| r.get::<_, i64>(0))
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect()
            };
            file_ids = if message_ids.is_empty() {
                Vec::new()
            } else {
                let placeholders = vec!["?"; message_ids.len()].join(",");
                let ids = {
                    let mut stmt = conn
                        .prepare(&format!(
                            "SELECT id FROM files WHERE message_id IN ({placeholders})"
                        ))
                        .unwrap();
                    stmt.query_map(params_from_iter(message_ids.iter()), |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect()
                };
                for table in ["messages", "files", "pins", "stars", "reactions", "mentions"] {
                    let column = if table == "messages" { "id" } else { "message_id" };
                    conn.execute(
                        &format!("DELETE FROM {table} WHERE {column} IN ({placeholders})"),
                        params_from_iter(message_ids.iter()),
                    )
                    .unwrap();
                }
                ids
            };
            for table in
                ["stars", "reads", "thread_reads", "thread_hides", "mentions", "user_prefs", "message_templates"]
            {
                conn.execute(
                    &format!("DELETE FROM {table} WHERE username = ?1"),
                    params![username],
                )
                .unwrap();
            }
            conn.execute("DELETE FROM reactions WHERE reactor_type = 'user' AND reactor_id = ?1", params![username]).unwrap();
            conn.execute("DELETE FROM pins WHERE pinned_by = ?1", params![username]).unwrap();
            conn.execute(
                "DELETE FROM memberships WHERE member_type = 'user' AND member_id = ?1",
                params![username],
            )
            .unwrap();
            conn.execute("DELETE FROM agent_dm_grants WHERE username = ?1", params![username]).unwrap();
            conn.execute(
                "UPDATE groups SET created_by = NULL WHERE created_by = ?1",
                params![username],
            )
            .unwrap();
        // Dropping the account row revokes the user's sessions too:
        // session verification requires a live, matching user.
        conn.execute("DELETE FROM users WHERE username = ?1", params![username]).unwrap();
        // Only this account's devices stop receiving pushes.
        conn.execute("DELETE FROM push_tokens WHERE username = ?1", params![username]).unwrap();
        }
        self.unlink_files(&file_ids);
        for channel_id in dm_channels { self.delete_channel(&channel_id); }
    }

    // ------------------------------------------------------------- members

    pub fn add_member(
        &self,
        group_id: &str,
        member_type: &str,
        member_id: &str,
        role: &str,
        channel_id: Option<&str>,
    ) {
        let conn = self.conn.lock().unwrap();
        let scoped = channel_id.is_some_and(|id| !id.is_empty());
        if member_type == "user" {
            if scoped {
                // Group-wide access already includes every channel. Keeping a
                // stale narrow row would unexpectedly resurrect access if the
                // group-wide row were later removed.
                let group_wide = conn.query_row(
                    "SELECT 1 FROM memberships WHERE group_id = ?1 AND channel_id = '' \
                     AND member_type = 'user' AND member_id = ?2 LIMIT 1",
                    params![group_id, member_id], |_| Ok(()),
                ).is_ok();
                if group_wide { return; }
            } else {
                conn.execute(
                    "DELETE FROM memberships WHERE group_id = ?1 AND member_type = 'user' \
                     AND member_id = ?2 AND channel_id != ''",
                    params![group_id, member_id],
                ).unwrap();
            }
        }
        insert_member(&conn, group_id, channel_id, member_type, member_id, role);
        if member_type == "user" {
            // A new member starts clean (like joining a Discord server): the
            // group's existing history isn't "unread" for them.
            conn.execute(
                "INSERT INTO reads (username, channel_id, last_read_id, updated_at) \
                 SELECT ?1, c.id, \
                   COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id), 0), ?2 \
                 FROM channels c WHERE c.group_id = ?3 AND (?4 = '' OR c.id = ?4) \
                 ON CONFLICT(username, channel_id) DO NOTHING",
                params![member_id, now(), group_id, channel_id.unwrap_or("")],
            )
            .unwrap();
        }
    }

    pub fn remove_member(
        &self,
        group_id: &str,
        member_type: &str,
        member_id: &str,
        channel_id: Option<&str>,
    ) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM memberships WHERE group_id = ?1 AND member_type = ?2 \
             AND member_id = ?3 AND channel_id = ?4",
            params![group_id, member_type, member_id, channel_id.unwrap_or("")],
        )
        .unwrap()
            > 0
    }

    /// Remove every scope for one member in a group. Used for leaving and
    /// explicit whole-roster removal; a missing channel must not mean only
    /// the empty-string sentinel.
    pub fn remove_member_all(&self, group_id: &str, member_type: &str, member_id: &str) -> bool {
        self.conn.lock().unwrap().execute(
            "DELETE FROM memberships WHERE group_id = ?1 AND member_type = ?2 AND member_id = ?3",
            params![group_id, member_type, member_id],
        ).unwrap() > 0
    }

    pub fn members(&self, group_id: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT channel_id, member_type, member_id, role, added_at FROM memberships \
                 WHERE group_id = ?1 ORDER BY member_type, member_id",
            )
            .unwrap();
        stmt.query_map(params![group_id], |r| {
            let chan: String = r.get(0)?;
            Ok(json!({
                "channel_id": if chan.is_empty() { Value::Null } else { Value::String(chan) },
                "member_type": r.get::<_, String>(1)?,
                "member_id": r.get::<_, String>(2)?,
                "role": r.get::<_, String>(3)?,
                "added_at": r.get::<_, f64>(4)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn all_user_memberships(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT m.group_id, g.name, m.channel_id, c.name, m.member_id, m.role, m.added_at \
             FROM memberships m JOIN groups g ON g.id = m.group_id \
             LEFT JOIN channels c ON c.id = m.channel_id \
             WHERE m.member_type = 'user' ORDER BY m.member_id, g.name, c.name",
        ).unwrap();
        stmt.query_map([], |r| {
            let channel_id: String = r.get(2)?;
            Ok(json!({
                "group_id": r.get::<_, String>(0)?, "group_name": r.get::<_, String>(1)?,
                "channel_id": if channel_id.is_empty() { Value::Null } else { json!(channel_id) },
                "channel_name": r.get::<_, Option<String>>(3)?, "member_id": r.get::<_, String>(4)?,
                "role": r.get::<_, String>(5)?, "added_at": r.get::<_, f64>(6)?,
            }))
        }).unwrap().filter_map(Result::ok).collect()
    }

    pub fn user_groups(&self, username: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT group_id FROM memberships WHERE member_type = 'user' AND member_id = ?1",
            )
            .unwrap();
        stmt.query_map(params![username], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    pub fn user_in_group(&self, username: &str, group_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM memberships WHERE group_id = ?1 AND member_type = 'user' AND member_id = ?2 LIMIT 1",
            params![group_id, username],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Member-level *access*: a membership row, or the group being public.
    /// Access-control call sites use this; membership listings and admin
    /// checks stay on the raw tables.
    pub fn user_can_access_group(&self, username: &str, group_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM groups g WHERE g.id = ?1 AND (g.is_public = 1 OR EXISTS ( \
                 SELECT 1 FROM memberships m WHERE m.group_id = g.id \
                 AND m.member_type = 'user' AND m.member_id = ?2))",
            params![group_id, username],
            |_| Ok(()),
        )
        .is_ok()
    }

    pub fn user_is_group_admin(&self, username: &str, group_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM memberships WHERE group_id = ?1 AND channel_id = '' \
             AND member_type = 'user' AND member_id = ?2 AND role = 'admin' LIMIT 1",
            params![group_id, username],
            |_| Ok(()),
        )
        .is_ok()
    }

    pub fn user_can_see_channel(&self, username: &str, channel_id: &str) -> bool {
        match self.channel(channel_id) {
            Some(chan) => {
                if chan["kind"] == "agent_dm" {
                    return chan["dm_user_id"].as_str() == Some(username);
                }
                let group_id = chan["group_id"].as_str().unwrap_or_default();
                let conn = self.conn.lock().unwrap();
                conn.query_row(
                    "SELECT 1 FROM groups g WHERE g.id = ?1 AND (g.is_public = 1 OR EXISTS ( \
                       SELECT 1 FROM memberships m WHERE m.group_id = g.id AND m.member_type = 'user' \
                       AND m.member_id = ?2 AND (m.channel_id = '' OR m.channel_id = ?3)))",
                    params![group_id, username, channel_id], |_| Ok(()),
                ).is_ok()
            }
            None => false,
        }
    }

    pub fn user_is_channel_admin(&self, username: &str, channel_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM channels c JOIN memberships m ON m.group_id = c.group_id \
             WHERE c.id = ?1 AND m.member_type = 'user' AND m.member_id = ?2 \
             AND m.role = 'admin' AND (m.channel_id = '' OR m.channel_id = c.id) LIMIT 1",
            params![channel_id, username], |_| Ok(()),
        ).is_ok()
    }

    /// Agent ids that are members of the channel — via a group-level
    /// membership (empty channel_id) or one scoped to this exact channel.
    pub fn agents_for_channel(&self, channel_id: &str) -> Vec<String> {
        let Some(chan) = self.channel(channel_id) else {
            return Vec::new();
        };
        if chan["kind"] == "agent_dm" {
            return chan["dm_agent_id"].as_str().map(|id| vec![id.to_string()]).unwrap_or_default();
        }
        let group_id = chan["group_id"].as_str().unwrap_or_default().to_string();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT member_id FROM memberships \
                 WHERE group_id = ?1 AND member_type = 'agent' \
                 AND (channel_id = '' OR channel_id = ?2)",
            )
            .unwrap();
        stmt.query_map(params![group_id, channel_id], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    /// Whether one agent is a member of a channel, either through a
    /// group-wide membership or a row scoped to that exact channel.
    pub fn agent_in_channel(&self, agent_id: &str, channel_id: &str) -> bool {
        if let Some(channel) = self.channel(channel_id).filter(|c| c["kind"] == "agent_dm") {
            return channel["dm_agent_id"].as_str() == Some(agent_id);
        }
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM channels c JOIN memberships m ON m.group_id = c.group_id \
             WHERE c.id = ?1 AND m.member_type = 'agent' AND m.member_id = ?2 \
             AND (m.channel_id = '' OR m.channel_id = c.id) LIMIT 1",
            params![channel_id, agent_id],
            |_| Ok(()),
        )
        .is_ok()
    }

    // ------------------------------------------------------- users / invites

    pub fn create_user(
        &self,
        username: &str,
        display_name: &str,
        email: Option<&str>,
        instance_role: &str,
    ) -> Option<Value> {
        let email = email.map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty());
        {
            let conn = self.conn.lock().unwrap();
            let inserted = conn
                .execute(
                    "INSERT INTO users (username, display_name, email, instance_role, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5) \
                     ON CONFLICT(username) DO NOTHING",
                    params![username, display_name, email, instance_role, now()],
                )
                .unwrap_or(0);
            if inserted == 0 {
                return None;
            }
        }
        self.user(username)
    }

    pub fn user(&self, username: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {USER_COLS} FROM users WHERE username = ?1"),
            params![username],
            user_row,
        )
        .ok()
    }

    pub fn user_by_email(&self, email: &str) -> Option<Value> {
        let email = email.trim().to_lowercase();
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {USER_COLS} FROM users WHERE email = ?1"),
            params![email],
            user_row,
        )
        .ok()
    }

    pub fn list_users(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("SELECT {USER_COLS} FROM users ORDER BY username"))
            .unwrap();
        stmt.query_map([], user_row).unwrap().filter_map(Result::ok).collect()
    }

    pub fn set_user_disabled(&self, username: &str, disabled: bool) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET disabled = ?1 WHERE username = ?2",
            params![disabled as i64, username],
        )
        .unwrap()
            > 0
    }

    /// Self-service rename; '' falls back to the username everywhere it is
    /// displayed.
    pub fn set_user_display_name(&self, username: &str, display_name: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET display_name = ?1 WHERE username = ?2",
            params![display_name, username],
        )
        .unwrap()
            > 0
    }

    pub fn set_user_instance_role(&self, username: &str, role: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET instance_role = ?1 WHERE username = ?2",
            params![role, username],
        )
        .unwrap()
            > 0
    }

    /// Invalidate every session the user holds: minted tokens embed the
    /// version and verification requires an exact match.
    pub fn bump_session_version(&self, username: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE users SET session_version = session_version + 1 WHERE username = ?1",
            params![username],
        )
        .unwrap();
        conn.query_row(
            "SELECT session_version FROM users WHERE username = ?1",
            params![username],
            |r| r.get(0),
        )
        .unwrap_or(1)
    }

    /// A free username derived from `base` (slugified; `-2`, `-3`, … on
    /// collision). Usernames double as @mention handles, so they get the
    /// same lowercase alnum-dash shape channel slugs do.
    pub fn unique_username(&self, base: &str) -> String {
        let base = {
            let s: String = slugify(base).chars().take(32).collect();
            if s.is_empty() { "user".to_string() } else { s }
        };
        if self.user(&base).is_none() {
            return base;
        }
        (2..)
            .map(|i| format!("{base}-{i}"))
            .find(|cand| self.user(cand).is_none())
            .unwrap()
    }

    pub fn create_invite(&self, email: &str, invited_by: Option<&str>, role: &str) -> Option<Value> {
        let email = email.trim().to_lowercase();
        if email.is_empty() || !email.contains('@') {
            return None;
        }
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO invites (email, invited_by, instance_role, created_at) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(email) DO UPDATE SET instance_role = excluded.instance_role, \
                   invited_by = excluded.invited_by, accepted_at = NULL",
                params![email, invited_by, role, now()],
            )
            .unwrap();
        }
        self.pending_invite(&email)
    }

    pub fn pending_invite(&self, email: &str) -> Option<Value> {
        let email = email.trim().to_lowercase();
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT email, invited_by, instance_role, created_at FROM invites \
             WHERE email = ?1 AND accepted_at IS NULL",
            params![email],
            |r| {
                Ok(json!({
                    "email": r.get::<_, String>(0)?,
                    "invited_by": r.get::<_, Option<String>>(1)?,
                    "instance_role": r.get::<_, String>(2)?,
                    "created_at": r.get::<_, f64>(3)?,
                }))
            },
        )
        .ok()
    }

    pub fn accept_invite(&self, email: &str) {
        let email = email.trim().to_lowercase();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE invites SET accepted_at = ?1 WHERE email = ?2",
            params![now(), email],
        )
        .unwrap();
    }

    pub fn list_invites(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT email, invited_by, instance_role, created_at, accepted_at \
                 FROM invites ORDER BY created_at DESC",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "email": r.get::<_, String>(0)?,
                "invited_by": r.get::<_, Option<String>>(1)?,
                "instance_role": r.get::<_, String>(2)?,
                "created_at": r.get::<_, f64>(3)?,
                "accepted_at": r.get::<_, Option<f64>>(4)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn delete_invite(&self, email: &str) -> bool {
        let email = email.trim().to_lowercase();
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM invites WHERE email = ?1", params![email]).unwrap() > 0
    }

    // --------------------------------------------------------- invite links

    /// Mint a single-use, expiring invite link token. Whoever signs in with
    /// it (any verified email) gets an account with `role`.
    pub fn create_invite_link(&self, invited_by: Option<&str>, role: &str, ttl_secs: f64) -> Value {
        let token = new_token();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO invite_links (token, invited_by, instance_role, created_at, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![token, invited_by, role, now(), now() + ttl_secs],
            )
            .unwrap();
        }
        self.invite_link(&token).unwrap_or(Value::Null)
    }

    pub fn invite_link(&self, token: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT token, invited_by, instance_role, created_at, expires_at, used_by, used_at \
             FROM invite_links WHERE token = ?1",
            params![token],
            |r| {
                Ok(json!({
                    "token": r.get::<_, String>(0)?,
                    "invited_by": r.get::<_, Option<String>>(1)?,
                    "instance_role": r.get::<_, String>(2)?,
                    "created_at": r.get::<_, f64>(3)?,
                    "expires_at": r.get::<_, f64>(4)?,
                    "used_by": r.get::<_, Option<String>>(5)?,
                    "used_at": r.get::<_, Option<f64>>(6)?,
                }))
            },
        )
        .ok()
    }

    /// The link if it can still admit someone (unused and unexpired).
    pub fn valid_invite_link(&self, token: &str) -> Option<Value> {
        self.invite_link(token)
            .filter(|l| l["used_by"].is_null() && l["expires_at"].as_f64().unwrap_or(0.0) > now())
    }

    /// Consume the link for `username`. The WHERE guard makes redemption
    /// atomic: two racing sign-ins can't both use the same link.
    pub fn use_invite_link(&self, token: &str, username: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE invite_links SET used_by = ?1, used_at = ?2 \
             WHERE token = ?3 AND used_by IS NULL AND expires_at > ?4",
            params![username, now(), token, now()],
        )
        .unwrap()
            > 0
    }

    pub fn list_invite_links(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT token, invited_by, instance_role, created_at, expires_at, used_by, used_at \
                 FROM invite_links ORDER BY created_at DESC",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "token": r.get::<_, String>(0)?,
                "invited_by": r.get::<_, Option<String>>(1)?,
                "instance_role": r.get::<_, String>(2)?,
                "created_at": r.get::<_, f64>(3)?,
                "expires_at": r.get::<_, f64>(4)?,
                "used_by": r.get::<_, Option<String>>(5)?,
                "used_at": r.get::<_, Option<f64>>(6)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn delete_invite_link(&self, token: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM invite_links WHERE token = ?1", params![token]).unwrap() > 0
    }

    // ------------------------------------------------------------- messages

    pub fn add_message(
        &self,
        channel_id: &str,
        text: &str,
        author_type: &str,
        author_id: &str,
        author_name: Option<&str>,
        thread_id: Option<i64>,
        attachments: &[NewAttachment],
    ) -> Value {
        self.add_message_with_meta(
            channel_id,
            text,
            author_type,
            author_id,
            author_name,
            thread_id,
            attachments,
            None,
        )
    }

    pub fn add_message_with_meta(
        &self,
        channel_id: &str,
        text: &str,
        author_type: &str,
        author_id: &str,
        author_name: Option<&str>,
        thread_id: Option<i64>,
        attachments: &[NewAttachment],
        meta: Option<&Value>,
    ) -> Value {
        let ts = now();
        let meta_json = meta
            .filter(|m| !m.is_null())
            .map(|m| m.to_string());
        let mut stored_files = Vec::new();
        let message_id;
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO messages (channel_id, thread_id, author_type, author_id, author_name, text, ts, meta) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    channel_id,
                    thread_id,
                    author_type,
                    author_id,
                    author_name,
                    text,
                    ts,
                    meta_json
                ],
            )
            .unwrap();
            message_id = conn.last_insert_rowid();
            for att in attachments {
                let file_id = new_token();
                std::fs::create_dir_all(&self.files_dir).ok();
                std::fs::write(self.files_dir.join(&file_id), &att.data).ok();
                conn.execute(
                    "INSERT INTO files (id, channel_id, message_id, filename, mime, size, ts) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![file_id, channel_id, message_id, att.filename, att.mime, att.data.len() as i64, ts],
                )
                .unwrap();
                stored_files.push(json!({
                    "id": file_id, "filename": att.filename,
                    "mime": att.mime, "size": att.data.len(),
                }));
            }
        }
        json!({
            "id": message_id,
            "channel_id": channel_id,
            "thread_id": thread_id,
            "author_type": author_type,
            "author_id": author_id,
            "author_name": author_name,
            "text": text,
            "ts": ts,
            "meta": meta.cloned().unwrap_or(Value::Null),
            "attachments": stored_files,
        })
    }

    /// Merge ``patch`` into a message's ``meta`` JSON and return the updated
    /// message. The read-merge-write runs under one connection lock: the
    /// unfurl worker and an option resolve can patch the same message
    /// concurrently, and a merge computed from a stale read would silently
    /// drop the other writer's keys.
    pub fn update_message_meta(&self, message_id: i64, patch: &Value) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            let raw: Option<String> = conn
                .query_row(
                    "SELECT meta FROM messages WHERE id = ?1",
                    params![message_id],
                    |r| r.get(0),
                )
                .ok()?;
            let mut meta = raw
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(Value::Null);
            if !meta.is_object() {
                meta = json!({});
            }
            if let (Some(obj), Some(patch_obj)) = (meta.as_object_mut(), patch.as_object()) {
                for (k, v) in patch_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
            conn.execute(
                "UPDATE messages SET meta = ?1 WHERE id = ?2",
                params![meta.to_string(), message_id],
            )
            .ok()?;
        }
        self.message(message_id)
    }

    /// Replace a message's text and stamp its meta in one locked write. The
    /// meta merge shares the lock with unfurl/form writers so an edit cannot
    /// overwrite keys they added concurrently. Unchanged text is a true no-op.
    pub fn update_message_text(
        &self,
        message_id: i64,
        text: &str,
    ) -> rusqlite::Result<Option<(Value, bool)>> {
        let changed;
        {
            let conn = self.conn.lock().unwrap();
            let Some((old_text, raw_meta)): Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT text, meta FROM messages WHERE id = ?1",
                    params![message_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
            else {
                return Ok(None);
            };
            changed = old_text != text;
            if changed {
                let mut meta = raw_meta
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .unwrap_or_else(|| json!({}));
                if !meta.is_object() {
                    meta = json!({});
                }
                meta.as_object_mut()
                    .unwrap()
                    .insert("edited_at".into(), json!(now()));
                if let Some(unfurls) = meta.get_mut("unfurls").and_then(Value::as_array_mut) {
                    unfurls.retain(|unfurl| {
                        unfurl["url"].as_str().is_some_and(|url| text.contains(url))
                    });
                }
                conn.execute(
                    "UPDATE messages SET text = ?1, meta = ?2 WHERE id = ?3",
                    params![text, meta.to_string(), message_id],
                )?;
            }
        }
        Ok(self.message(message_id).map(|message| (message, changed)))
    }

    /// Load a message's meta for a form mutation, or the error the caller
    /// should surface: rows without a form can't take form writes, and a
    /// locked form refuses everything. Callers hold the connection lock.
    fn load_form_meta(
        conn: &rusqlite::Connection,
        message_id: i64,
    ) -> Result<Value, &'static str> {
        let raw: Option<String> = conn
            .query_row(
                "SELECT meta FROM messages WHERE id = ?1",
                params![message_id],
                |r| r.get(0),
            )
            .map_err(|_| "Message not found")?;
        let meta = raw
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);
        if !meta.get("form").map(|f| f.is_object()).unwrap_or(false) {
            return Err("Message has no form");
        }
        if meta.get("form_submitted").map(|r| !r.is_null()).unwrap_or(false) {
            return Err("Form already submitted");
        }
        Ok(meta)
    }

    /// Set one field's value in a message's shared form state and return the
    /// updated message. The read-check-write runs under one connection lock:
    /// two members editing different fields must not lose each other's
    /// values, and an edit must not slip past a concurrent submit's lock.
    pub fn update_form_field(
        &self,
        message_id: i64,
        field_id: &str,
        value: &Value,
    ) -> Result<Value, &'static str> {
        {
            let conn = self.conn.lock().unwrap();
            let mut meta = Self::load_form_meta(&conn, message_id)?;
            let obj = meta.as_object_mut().unwrap();
            let state = obj.entry("form_state").or_insert_with(|| json!({}));
            if !state.is_object() {
                *state = json!({});
            }
            state
                .as_object_mut()
                .unwrap()
                .insert(field_id.to_string(), value.clone());
            conn.execute(
                "UPDATE messages SET meta = ?1 WHERE id = ?2",
                params![meta.to_string(), message_id],
            )
            .map_err(|_| "Failed to update message")?;
        }
        self.message(message_id).ok_or("Message not found")
    }

    /// Lock a form: record the pressed button plus a snapshot of the shared
    /// state, and return the updated message. Check-and-set runs under one
    /// connection lock, so exactly one submitter wins — the loser (and any
    /// later field edit) gets "Form already submitted".
    pub fn submit_form(
        &self,
        message_id: i64,
        button_id: &str,
        by: &str,
    ) -> Result<Value, &'static str> {
        {
            let conn = self.conn.lock().unwrap();
            let mut meta = Self::load_form_meta(&conn, message_id)?;
            let values = meta.get("form_state").cloned().unwrap_or_else(|| json!({}));
            meta.as_object_mut().unwrap().insert(
                "form_submitted".into(),
                json!({
                    "button_id": button_id,
                    "by": by,
                    "ts": now(),
                    "values": values,
                }),
            );
            conn.execute(
                "UPDATE messages SET meta = ?1 WHERE id = ?2",
                params![meta.to_string(), message_id],
            )
            .map_err(|_| "Failed to update message")?;
        }
        self.message(message_id).ok_or("Message not found")
    }

    /// Delete one message. A thread root takes its replies with it (replies
    /// pointing at a deleted root would dangle — same rule as
    /// [`Store::delete_user_data`]), along with everything keyed to the
    /// removed rows: attachments (files unlinked from disk), pins, stars,
    /// reactions, mentions, and the thread's read/hide markers.
    pub fn delete_message(&self, message_id: i64) -> bool {
        let file_ids: Vec<String>;
        let deleted;
        {
            let conn = self.conn.lock().unwrap();
            let message_ids: Vec<i64> = {
                let mut stmt = conn
                    .prepare("SELECT id FROM messages WHERE id = ?1 OR thread_id = ?1")
                    .unwrap();
                stmt.query_map(params![message_id], |r| r.get::<_, i64>(0))
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect()
            };
            if message_ids.is_empty() {
                return false;
            }
            let placeholders = vec!["?"; message_ids.len()].join(",");
            file_ids = {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT id FROM files WHERE message_id IN ({placeholders})"
                    ))
                    .unwrap();
                stmt.query_map(params_from_iter(message_ids.iter()), |r| {
                    r.get::<_, String>(0)
                })
                .unwrap()
                .filter_map(Result::ok)
                .collect()
            };
            for table in ["messages", "files", "pins", "stars", "reactions", "mentions"] {
                let column = if table == "messages" { "id" } else { "message_id" };
                conn.execute(
                    &format!("DELETE FROM {table} WHERE {column} IN ({placeholders})"),
                    params_from_iter(message_ids.iter()),
                )
                .unwrap();
            }
            for table in ["thread_reads", "thread_hides"] {
                conn.execute(
                    &format!("DELETE FROM {table} WHERE thread_id = ?1"),
                    params![message_id],
                )
                .unwrap();
            }
            deleted = true;
        }
        self.unlink_files(&file_ids);
        deleted
    }

    /// Find an agent's own message in one channel whose meta.options_id
    /// matches. Both channel and author scopes are authorization boundaries.
    pub fn find_message_by_options_id(
        &self,
        channel_id: &str,
        agent_id: &str,
        options_id: &str,
    ) -> Option<i64> {
        if channel_id.is_empty() || agent_id.is_empty() || options_id.is_empty() {
            return None;
        }
        let conn = self.conn.lock().unwrap();
        // SQLite json1: meta is a JSON text column.
        conn.query_row(
            "SELECT id FROM messages WHERE meta IS NOT NULL \
             AND channel_id = ?1 AND author_type = 'agent' AND author_id = ?2 \
             AND json_extract(meta, '$.options_id') = ?3 \
             ORDER BY id DESC LIMIT 1",
            params![channel_id, agent_id, options_id],
            |r| r.get(0),
        )
        .ok()
    }

    // ------------------------------------------------------------- unfurl cache

    /// A cached link preview: `Some((ok, meta))` while fresh, `None` when
    /// missing or expired (expired rows are simply overwritten by the next
    /// `unfurl_cache_put` — no sweeper needed at this table's size).
    pub fn unfurl_cache_get(&self, url: &str) -> Option<(bool, Value)> {
        let conn = self.conn.lock().unwrap();
        let (ok, meta, fetched_at): (i64, String, f64) = conn
            .query_row(
                "SELECT ok, meta, fetched_at FROM unfurl_cache WHERE url = ?1",
                params![url],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()?;
        let ok = ok != 0;
        let ttl = if ok { UNFURL_TTL_OK } else { UNFURL_TTL_ERR };
        if now() - fetched_at > ttl {
            return None;
        }
        Some((ok, serde_json::from_str(&meta).unwrap_or_else(|_| json!({}))))
    }

    pub fn unfurl_cache_put(&self, url: &str, ok: bool, meta: &Value) {
        self.unfurl_cache_put_at(url, ok, meta, now());
    }

    fn unfurl_cache_put_at(&self, url: &str, ok: bool, meta: &Value, fetched_at: f64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO unfurl_cache (url, ok, meta, fetched_at) VALUES (?1, ?2, ?3, ?4)",
            params![url, ok as i64, meta.to_string(), fetched_at],
        )
        .unwrap();
    }

    pub fn message(&self, message_id: i64) -> Option<Value> {
        let msg = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                &format!("SELECT {MSG_COLS}, thread_alias FROM messages WHERE id = ?1"),
                params![message_id],
                |r| {
                    let mut m = message_row(r, 0)?;
                    m["alias"] = json!(r.get::<_, Option<String>>(9)?);
                    Ok(m)
                },
            )
            .ok()?
        };
        Some(self.attach_files(vec![msg]).remove(0))
    }

    /// Newest-last page of a channel's top level (`thread_id` None) or one
    /// thread. Top-level pages carry each root's reply count.
    pub fn messages(
        &self,
        channel_id: &str,
        thread_id: Option<i64>,
        before_id: Option<i64>,
        limit: usize,
    ) -> Vec<Value> {
        let mut rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            // `thread_alias` rides along so thread roots surface their rename
            // in channel pages (replies carry NULL; the key just stays null).
            let mut sql = format!("SELECT {MSG_COLS}, thread_alias FROM messages WHERE channel_id = ?1 AND ");
            sql.push_str(if thread_id.is_some() { "thread_id = ?2" } else { "thread_id IS NULL" });
            let mut p: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(channel_id.to_string())];
            if let Some(t) = thread_id {
                p.push(Box::new(t));
            }
            if let Some(b) = before_id {
                sql.push_str(&format!(" AND id < ?{}", p.len() + 1));
                p.push(Box::new(b));
            }
            sql.push_str(&format!(" ORDER BY id DESC LIMIT ?{}", p.len() + 1));
            p.push(Box::new(limit as i64));
            let mut stmt = conn.prepare(&sql).unwrap();
            stmt.query_map(params_from_iter(p.iter().map(|b| b.as_ref())), |r| {
                let mut m = message_row(r, 0)?;
                m["alias"] = json!(r.get::<_, Option<String>>(9)?);
                Ok(m)
            })
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        rows.reverse();
        let mut out = self.attach_files(rows);
        if thread_id.is_none() && !out.is_empty() {
            let ids: Vec<i64> = out.iter().filter_map(|m| m["id"].as_i64()).collect();
            let placeholders = vec!["?"; ids.len()].join(",");
            let counts: std::collections::HashMap<i64, i64> = {
                let conn = self.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT thread_id, COUNT(*) FROM messages WHERE thread_id IN ({placeholders}) GROUP BY thread_id"
                    ))
                    .unwrap();
                stmt.query_map(params_from_iter(ids.iter()), |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })
                .unwrap()
                .filter_map(Result::ok)
                .collect()
            };
            for m in &mut out {
                let id = m["id"].as_i64().unwrap_or_default();
                m["reply_count"] = json!(counts.get(&id).copied().unwrap_or(0));
            }
        }
        out
    }

    pub fn thread_size(&self, thread_id: i64) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE thread_id = ?1",
            params![thread_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    // ------------------------------------------------------------- search

    /// Full-text search over message text, best match first (bm25) unless
    /// `newest_first`. Each hit is the message plus its channel/group names
    /// and a `snippet` where matched terms are wrapped in \u{1}…\u{2} (clients
    /// escape the text, then swap the markers for their highlight markup).
    ///
    /// `channel_id`/`group_id`/`author` narrow the scope. `agent_id` restricts
    /// hits to channels that agent is a member of — the same visibility rule
    /// as inbound fan-out — for the agent-protocol search frame. `user`
    /// restricts hits to groups that user is a member of (the UI search path;
    /// pass None for a privileged caller). `match_any` switches from
    /// all-terms to any-term matching (AI answer retrieval).
    #[allow(clippy::too_many_arguments)]
    pub fn search_messages(
        &self,
        query: &str,
        match_any: bool,
        channel_id: Option<&str>,
        group_id: Option<&str>,
        author: Option<&str>,
        agent_id: Option<&str>,
        user: Option<&str>,
        newest_first: bool,
        limit: usize,
        offset: usize,
    ) -> Vec<Value> {
        self.search_messages_ext(
            query, match_any, channel_id, group_id, author, agent_id, user, newest_first, false,
            None, limit, offset,
        )
    }

    /// [`search_messages`] plus the attachment controls the search UIs expose:
    /// `has_files` keeps only messages carrying an attachment, and `file_type`
    /// (`image`/`video`/`audio`/`pdf`/`doc`) narrows to one kind. Attachment
    /// *filenames* are always part of the match, so "budget.xlsx" surfaces the
    /// message that carried it even when the text says nothing. With an empty
    /// query but `has_files`/`file_type` set, this browses every message with a
    /// (matching) attachment, newest first. Every hit carries its
    /// `attachments` array so callers can render file chips.
    #[allow(clippy::too_many_arguments)]
    pub fn search_messages_ext(
        &self,
        query: &str,
        match_any: bool,
        channel_id: Option<&str>,
        group_id: Option<&str>,
        author: Option<&str>,
        agent_id: Option<&str>,
        user: Option<&str>,
        newest_first: bool,
        has_files: bool,
        file_type: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Vec<Value> {
        let want_attach = has_files || file_type.is_some();
        let fts = if query.trim().is_empty() {
            None
        } else if match_any {
            fts_query_any(query)
        } else {
            fts_query(query)
        };
        // Nothing to match on: no usable text query and no attachment filter.
        if fts.is_none() && !want_attach {
            return Vec::new();
        }

        // The attachment filter, when asked for, restricts to messages with a
        // file (optionally of one kind). An unknown `file_type` falls back to
        // "any attachment" rather than matching nothing.
        let attach_clause = if want_attach {
            let kind = file_type.and_then(|kind| file_kind_predicate(kind, "ff"));
            let extra = kind.map(|k| format!(" AND {k}")).unwrap_or_default();
            format!(" AND EXISTS (SELECT 1 FROM files ff WHERE ff.message_id = m.id{extra})")
        } else {
            String::new()
        };

        let rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut p: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            let mut sql;
            if let Some(fts) = fts {
                // Drive off the union of text hits (FTS) and filename hits
                // (LIKE), then hang the ranked snippet off the text side.
                p.push(Box::new(fts)); // ?1, used by both the union and `th`
                p.push(Box::new(like_pattern(query))); // ?2
                sql = String::from(
                    "SELECT m.id, m.channel_id, m.thread_id, m.author_type, m.author_id, \
                       m.author_name, m.text, m.ts, m.meta, \
                       c.name, c.group_id, COALESCE(g.name, ''), COALESCE(th.snip, '') \
                     FROM (SELECT rowid AS mid FROM messages_fts WHERE messages_fts MATCH ?1 \
                           UNION \
                           SELECT message_id AS mid FROM files WHERE filename LIKE ?2 ESCAPE '\\') hits \
                     JOIN messages m ON m.id = hits.mid \
                     JOIN channels c ON c.id = m.channel_id \
                     LEFT JOIN groups g ON g.id = c.group_id \
                     LEFT JOIN (SELECT messages_fts.rowid AS mid, rank AS score, \
                                  snippet(messages_fts, 0, char(1), char(2), '…', 16) AS snip \
                                FROM messages_fts WHERE messages_fts MATCH ?1) th ON th.mid = m.id \
                     WHERE 1=1",
                );
            } else {
                // Browse mode: no query, just messages carrying attachments.
                sql = String::from(
                    "SELECT m.id, m.channel_id, m.thread_id, m.author_type, m.author_id, \
                       m.author_name, m.text, m.ts, m.meta, \
                       c.name, c.group_id, COALESCE(g.name, ''), '' \
                     FROM messages m \
                     JOIN channels c ON c.id = m.channel_id \
                     LEFT JOIN groups g ON g.id = c.group_id \
                     WHERE 1=1",
                );
            }
            sql.push_str(&attach_clause);
            if let Some(cid) = channel_id {
                sql.push_str(&format!(" AND m.channel_id = ?{}", p.len() + 1));
                p.push(Box::new(cid.to_string()));
            }
            if let Some(gid) = group_id {
                sql.push_str(&format!(" AND c.group_id = ?{}", p.len() + 1));
                p.push(Box::new(gid.to_string()));
            }
            if let Some(a) = author {
                let i = p.len() + 1;
                sql.push_str(&format!(" AND (m.author_id = ?{i} OR m.author_name = ?{i})"));
                p.push(Box::new(a.to_string()));
            }
            if let Some(agent) = agent_id {
                let i = p.len() + 1;
                sql.push_str(&format!(
                    " AND ((c.kind = 'agent_dm' AND c.dm_agent_id = ?{i} AND EXISTS ( \
                         SELECT 1 FROM users du WHERE du.username = c.dm_user_id AND du.disabled = 0 AND ( \
                           du.instance_role = 'admin' OR EXISTS (SELECT 1 FROM agent_dm_policies dp WHERE dp.agent_id = c.dm_agent_id AND dp.is_public = 1) OR \
                           EXISTS (SELECT 1 FROM agent_dm_grants dg WHERE dg.agent_id = c.dm_agent_id AND dg.username = c.dm_user_id)))) \
                       OR EXISTS (SELECT 1 FROM memberships ms \
                       WHERE ms.member_type = 'agent' AND ms.member_id = ?{i} \
                       AND ms.group_id = c.group_id \
                       AND (ms.channel_id = '' OR ms.channel_id = m.channel_id)))"
                ));
                p.push(Box::new(agent.to_string()));
            }
            // User visibility mirrors the UI: a person sees a channel iff
            // they are a member of its group (users are group-scoped), or
            // the group is public.
            if let Some(username) = user {
                let i = p.len() + 1;
                sql.push_str(&format!(
                    " AND ((c.kind = 'agent_dm' AND c.dm_user_id = ?{i}) OR (c.kind != 'agent_dm' AND (g.is_public = 1 OR EXISTS (SELECT 1 FROM memberships mu \
                       WHERE mu.member_type = 'user' AND mu.member_id = ?{i} \
                       AND mu.group_id = c.group_id AND (mu.channel_id = '' OR mu.channel_id = c.id)))))"
                ));
                p.push(Box::new(username.to_string()));
            } else {
                sql.push_str(" AND c.kind != 'agent_dm'");
            }
            // Text hits first (best bm25), then filename-only hits; newest_first
            // and browse mode both just order by recency.
            if newest_first || query.trim().is_empty() {
                sql.push_str(" ORDER BY m.id DESC");
            } else {
                sql.push_str(" ORDER BY (th.mid IS NOT NULL) DESC, th.score ASC, m.id DESC");
            }
            sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", p.len() + 1, p.len() + 2));
            p.push(Box::new(limit as i64));
            p.push(Box::new(offset as i64));
            let mut stmt = conn.prepare(&sql).unwrap();
            stmt.query_map(params_from_iter(p.iter().map(|b| b.as_ref())), |r| {
                let mut msg = message_row(r, 0)?;
                msg["channel_name"] = json!(r.get::<_, String>(9)?);
                msg["group_id"] = json!(r.get::<_, String>(10)?);
                msg["group_name"] = json!(r.get::<_, String>(11)?);
                msg["snippet"] = json!(r.get::<_, String>(12)?);
                Ok(msg)
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect()
        };
        // Surface each hit's files so the search UIs can render chips/thumbnails.
        self.attach_files(rows)
    }

    /// Channels whose name or topic contains `query` (case-insensitive).
    /// `visible_to` limits hits to groups that user belongs to (None =
    /// privileged caller, no filter).
    pub fn search_channels(&self, query: &str, visible_to: Option<&str>, limit: usize) -> Vec<Value> {
        let pattern = like_pattern(query);
        let member_clause = if visible_to.is_some() {
            " AND (g.is_public = 1 OR EXISTS (SELECT 1 FROM memberships mu WHERE mu.member_type = 'user' \
               AND mu.member_id = ?3 AND mu.group_id = c.group_id \
               AND (mu.channel_id = '' OR mu.channel_id = c.id)))"
        } else {
            ""
        };
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT c.id, c.group_id, c.name, c.topic, c.hidden, COALESCE(g.name, '') \
                 FROM channels c LEFT JOIN groups g ON g.id = c.group_id \
                 WHERE c.kind != 'agent_dm' AND (c.name LIKE ?1 ESCAPE '\\' OR c.topic LIKE ?1 ESCAPE '\\'){member_clause} \
                 ORDER BY c.name LIMIT ?2",
            ))
            .unwrap();
        let map = |r: &rusqlite::Row<'_>| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "group_id": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?,
                "topic": r.get::<_, String>(3)?,
                "hidden": r.get::<_, i64>(4)? != 0,
                "group_name": r.get::<_, String>(5)?,
            }))
        };
        match visible_to {
            Some(user) => stmt
                .query_map(params![pattern, limit as i64, user], map)
                .unwrap()
                .filter_map(Result::ok)
                .collect(),
            None => stmt
                .query_map(params![pattern, limit as i64], map)
                .unwrap()
                .filter_map(Result::ok)
                .collect(),
        }
    }

    /// Groups whose name or description contains `query` (case-insensitive).
    /// `visible_to` limits hits to the user's groups, like [`search_channels`].
    pub fn search_groups(&self, query: &str, visible_to: Option<&str>, limit: usize) -> Vec<Value> {
        let pattern = like_pattern(query);
        let member_clause = if visible_to.is_some() {
            " AND (groups.is_public = 1 OR EXISTS (SELECT 1 FROM memberships mu WHERE mu.member_type = 'user' \
               AND mu.member_id = ?3 AND mu.group_id = groups.id))"
        } else {
            ""
        };
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, name, description, hidden FROM groups \
                 WHERE (name LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\'){member_clause} \
                 ORDER BY name LIMIT ?2",
            ))
            .unwrap();
        let map = |r: &rusqlite::Row<'_>| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "hidden": r.get::<_, i64>(3)? != 0,
            }))
        };
        match visible_to {
            Some(user) => stmt
                .query_map(params![pattern, limit as i64, user], map)
                .unwrap()
                .filter_map(Result::ok)
                .collect(),
            None => stmt
                .query_map(params![pattern, limit as i64], map)
                .unwrap()
                .filter_map(Result::ok)
                .collect(),
        }
    }

    // ------------------------------------------------------------- files

    pub fn file(&self, file_id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, channel_id, message_id, filename, mime, size, ts FROM files WHERE id = ?1",
            params![file_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "channel_id": r.get::<_, String>(1)?,
                    "message_id": r.get::<_, i64>(2)?, "filename": r.get::<_, String>(3)?,
                    "mime": r.get::<_, String>(4)?, "size": r.get::<_, i64>(5)?,
                    "ts": r.get::<_, f64>(6)?,
                }))
            },
        )
        .ok()
    }

    pub fn file_path(&self, file_id: &str) -> PathBuf {
        self.files_dir.join(file_id)
    }

    /// Page individual files in a channel, optionally restricted to one
    /// thread (root included). File rows, rather than messages, are the paging
    /// unit so a multi-file message cannot make page sizes uneven.
    pub fn list_attachments(
        &self,
        channel_id: &str,
        thread_id: Option<i64>,
        file_type: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Vec<Value> {
        let kind = file_type.and_then(|kind| file_kind_predicate(kind, "f"))
            .map(|p| format!(" AND {p}"))
            .unwrap_or_default();
        let thread = if thread_id.is_some() {
            " AND (m.id = ?2 OR m.thread_id = ?2)"
        } else { "" };
        let limit_i = if thread_id.is_some() { 3 } else { 2 };
        let offset_i = limit_i + 1;
        let sql = format!(
            "SELECT f.id, f.filename, f.mime, f.size, f.channel_id, f.message_id, \
                    m.thread_id, m.author_type, m.author_id, m.author_name, m.text, m.ts, \
                    CASE \
                      WHEN m.thread_id IS NOT NULL THEN COALESCE(NULLIF(r.thread_alias, ''), substr(r.text, 1, 140)) \
                      WHEN NULLIF(m.thread_alias, '') IS NOT NULL OR EXISTS (SELECT 1 FROM messages rp WHERE rp.thread_id = m.id) \
                        THEN COALESCE(NULLIF(m.thread_alias, ''), substr(m.text, 1, 140)) \
                      ELSE NULL END \
             FROM files f JOIN messages m ON m.id = f.message_id \
             LEFT JOIN messages r ON r.id = m.thread_id \
             WHERE f.channel_id = ?1{thread}{kind} \
             ORDER BY m.id DESC, f.rowid DESC LIMIT ?{limit_i} OFFSET ?{offset_i}"
        );
        let conn = self.conn.lock().unwrap();
        let map = |r: &rusqlite::Row<'_>| Ok(json!({
            "id": r.get::<_, String>(0)?, "filename": r.get::<_, String>(1)?,
            "mime": r.get::<_, String>(2)?, "size": r.get::<_, i64>(3)?,
            "channel_id": r.get::<_, String>(4)?, "message_id": r.get::<_, i64>(5)?,
            "thread_id": r.get::<_, Option<i64>>(6)?, "author_type": r.get::<_, String>(7)?,
            "author_id": r.get::<_, String>(8)?, "author_name": r.get::<_, Option<String>>(9)?,
            "message_text": r.get::<_, String>(10)?, "ts": r.get::<_, f64>(11)?,
            "thread_name": r.get::<_, Option<String>>(12)?,
        }));
        let mut stmt = conn.prepare(&sql).unwrap();
        if let Some(root) = thread_id {
            stmt.query_map(params![channel_id, root, limit as i64, offset as i64], map)
                .unwrap().filter_map(Result::ok).collect()
        } else {
            stmt.query_map(params![channel_id, limit as i64, offset as i64], map)
                .unwrap().filter_map(Result::ok).collect()
        }
    }

    /// Remove one attachment row and its bytes, leaving its message and any
    /// sibling attachments intact. Returns the refreshed parent message.
    pub fn delete_attachment(&self, file_id: &str) -> Option<Value> {
        let message_id;
        {
            let conn = self.conn.lock().unwrap();
            message_id = conn.query_row(
                "SELECT message_id FROM files WHERE id = ?1", params![file_id], |r| r.get::<_, i64>(0),
            ).ok()?;
            conn.execute("DELETE FROM files WHERE id = ?1", params![file_id]).ok()?;
        }
        self.unlink_files(&[file_id.to_string()]);
        self.message(message_id)
    }

    fn attach_files(&self, mut messages: Vec<Value>) -> Vec<Value> {
        if messages.is_empty() {
            return messages;
        }
        let ids: Vec<i64> = messages.iter().filter_map(|m| m["id"].as_i64()).collect();
        let placeholders = vec!["?"; ids.len()].join(",");
        let mut by_message: std::collections::HashMap<i64, Vec<Value>> = Default::default();
        {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT message_id, id, filename, mime, size FROM files \
                     WHERE message_id IN ({placeholders}) ORDER BY rowid"
                ))
                .unwrap();
            let rows = stmt
                .query_map(params_from_iter(ids.iter()), |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        json!({
                            "id": r.get::<_, String>(1)?, "filename": r.get::<_, String>(2)?,
                            "mime": r.get::<_, String>(3)?, "size": r.get::<_, i64>(4)?,
                        }),
                    ))
                })
                .unwrap()
                .filter_map(Result::ok);
            for (mid, f) in rows {
                by_message.entry(mid).or_default().push(f);
            }
        }
        for m in &mut messages {
            let id = m["id"].as_i64().unwrap_or_default();
            m["attachments"] = Value::Array(by_message.remove(&id).unwrap_or_default());
        }
        self.attach_reactions(&mut messages);
        messages
    }

    /// Aggregates the reactions rows onto each message as
    /// `[{emoji, users: [...]}]`, emoji groups in first-reaction order and
    /// users in reaction order. Always set (empty array included) so a
    /// `message_update` merge on the clients can clear the last chip.
    fn attach_reactions(&self, messages: &mut [Value]) {
        let ids: Vec<i64> = messages.iter().filter_map(|m| m["id"].as_i64()).collect();
        if ids.is_empty() {
            return;
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let mut by_message: std::collections::HashMap<i64, Vec<(String, Vec<(String, Value)>)>> =
            Default::default();
        {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT r.message_id, r.emoji, r.username, r.reactor_type, r.reactor_id, \
                     CASE WHEN r.reactor_type = 'agent' THEN a.name ELSE u.display_name END FROM reactions r \
                     LEFT JOIN agents a ON r.reactor_type = 'agent' AND a.id = r.reactor_id \
                     LEFT JOIN users u ON r.reactor_type = 'user' AND u.username = r.reactor_id \
                     WHERE r.message_id IN ({placeholders}) ORDER BY r.reacted_at, r.rowid"
                ))
                .unwrap();
            let rows = stmt
                .query_map(params_from_iter(ids.iter()), |r| {
                    let legacy = r.get::<_, String>(2)?;
                    let kind = r.get::<_, String>(3)?;
                    let id = r.get::<_, String>(4)?;
                    let name = r.get::<_, Option<String>>(5)?.filter(|n| !n.is_empty()).unwrap_or_else(|| legacy.clone());
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, legacy, json!({"type": kind, "id": id, "name": name})))
                })
                .unwrap()
                .filter_map(Result::ok);
            for (mid, emoji, user, reactor) in rows {
                let groups = by_message.entry(mid).or_default();
                match groups.iter_mut().find(|g| g.0 == emoji) {
                    Some(g) => g.1.push((user, reactor)),
                    None => groups.push((emoji, vec![(user, reactor)])),
                }
            }
        }
        for m in messages.iter_mut() {
            let id = m["id"].as_i64().unwrap_or_default();
            let groups = by_message.remove(&id).unwrap_or_default();
            m["reactions"] = Value::Array(
                groups
                    .into_iter()
                    .map(|(emoji, entries)| { let (users, reactors): (Vec<_>, Vec<_>) = entries.into_iter().unzip(); json!({"emoji": emoji, "users": users, "reactors": reactors}) })
                    .collect(),
            );
        }
    }

    fn unlink_files(&self, file_ids: &[String]) {
        for id in file_ids {
            if let Err(error) = std::fs::remove_file(self.files_dir.join(id)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(file_id = %id, %error, "failed to delete attachment bytes");
                }
            }
        }
    }

    // ------------------------------------------------------------- stars

    pub fn star_message(&self, username: &str, channel_id: &str, message_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO stars (username, channel_id, message_id, starred_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(username, message_id) DO NOTHING",
            params![username, channel_id, message_id, now()],
        )
        .unwrap()
            > 0
    }

    pub fn unstar_message(&self, username: &str, message_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM stars WHERE username = ?1 AND message_id = ?2",
            params![username, message_id],
        )
        .unwrap()
            > 0
    }

    // --------------------------------------------------------- reactions

    pub fn add_reaction(
        &self,
        username: &str,
        channel_id: &str,
        message_id: i64,
        emoji: &str,
    ) -> bool {
        self.add_typed_reaction("user", username, username, channel_id, message_id, emoji)
    }

    pub fn add_agent_reaction(&self, id: &str, name: &str, channel_id: &str, message_id: i64, emoji: &str) -> bool {
        self.add_typed_reaction("agent", id, name, channel_id, message_id, emoji)
    }

    fn add_typed_reaction(&self, kind: &str, id: &str, legacy: &str, channel_id: &str, message_id: i64, emoji: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reactions (channel_id, message_id, username, emoji, reacted_at, reactor_type, reactor_id) \
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 \
             WHERE NOT EXISTS (SELECT 1 FROM reactions WHERE message_id = ?2 \
               AND emoji = ?4 AND reactor_type = ?6 AND reactor_id = ?7) \
             ON CONFLICT(message_id, username, emoji) DO NOTHING",
            params![channel_id, message_id, legacy, emoji, now(), kind, id],
        )
        .unwrap()
            > 0
    }

    pub fn remove_reaction(&self, username: &str, message_id: i64, emoji: &str) -> bool {
        self.remove_typed_reaction("user", username, message_id, emoji)
    }

    pub fn remove_agent_reaction(&self, id: &str, message_id: i64, emoji: &str) -> bool {
        self.remove_typed_reaction("agent", id, message_id, emoji)
    }

    fn remove_typed_reaction(&self, kind: &str, id: &str, message_id: i64, emoji: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM reactions WHERE reactor_type = ?1 AND reactor_id = ?2 AND message_id = ?3 AND emoji = ?4",
            params![kind, id, message_id, emoji],
        )
        .unwrap()
            > 0
    }

    /// The user's starred messages in a channel (newest star first). Thread
    /// replies carry their `root` message too so the UI can open the thread.
    pub fn user_stars(&self, username: &str, channel_id: &str) -> Vec<Value> {
        let rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT m.id, m.channel_id, m.thread_id, m.author_type, m.author_id, \
                     m.author_name, m.text, m.ts, m.meta, s.starred_at, \
                     r.id, r.channel_id, r.thread_id, r.author_type, r.author_id, \
                     r.author_name, r.text, r.ts, r.meta \
                     FROM stars s JOIN messages m ON m.id = s.message_id \
                     LEFT JOIN messages r ON r.id = m.thread_id \
                     WHERE s.username = ?1 AND s.channel_id = ?2 ORDER BY s.starred_at DESC",
                )
                .unwrap();
            stmt.query_map(params![username, channel_id], |r| {
                let mut star = message_row(r, 0)?;
                star["starred_at"] = json!(r.get::<_, f64>(9)?);
                star["root"] = match r.get::<_, Option<i64>>(10)? {
                    Some(_) => message_row(r, 10)?,
                    None => Value::Null,
                };
                Ok(star)
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect()
        };
        self.attach_files(rows)
    }

    // ------------------------------------------------------------- reads

    /// Advance the user's read marker (None = channel max id). Monotonic —
    /// a stale ack never moves it backwards. Returns the effective marker.
    pub fn mark_read(&self, username: &str, channel_id: &str, message_id: Option<i64>) -> i64 {
        let conn = self.conn.lock().unwrap();
        let target = match message_id {
            Some(id) => id.max(0),
            None => conn
                .query_row(
                    "SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ?1",
                    params![channel_id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0),
        };
        conn.execute(
            "INSERT INTO reads (username, channel_id, last_read_id, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(username, channel_id) DO UPDATE SET \
             last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at",
            params![username, channel_id, target, now()],
        )
        .unwrap();
        conn.query_row(
            "SELECT last_read_id FROM reads WHERE username = ?1 AND channel_id = ?2",
            params![username, channel_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Per-channel unread state: `{channel_id: {count, mentions, last_read_id}}`.
    /// Unread = **top-level** messages newer than the marker, own messages
    /// excluded (thread replies surface via thread unreads, not here).
    /// Mentions count @you messages (any thread) newer than the marker.
    pub fn unread_counts(&self, username: &str, channel_ids: &[String]) -> Value {
        if channel_ids.is_empty() {
            return json!({});
        }
        let placeholders = vec!["?"; channel_ids.len()].join(",");
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT c.id, COALESCE(r.last_read_id, 0), COUNT(m.id), \
                   (SELECT COUNT(*) FROM mentions mn WHERE mn.channel_id = c.id \
                     AND mn.username = ?1 AND mn.message_id > COALESCE(r.last_read_id, 0)) \
                 FROM channels c \
                 LEFT JOIN reads r ON r.username = ?1 AND r.channel_id = c.id \
                 LEFT JOIN messages m ON m.channel_id = c.id \
                   AND m.thread_id IS NULL \
                   AND m.id > COALESCE(r.last_read_id, 0) \
                   AND NOT (m.author_type = 'user' AND m.author_id = ?2) \
                 WHERE c.id IN ({placeholders}) GROUP BY c.id"
            ))
            .unwrap();
        let mut p: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(username.to_string()), Box::new(username.to_string())];
        for id in channel_ids {
            p.push(Box::new(id.clone()));
        }
        let mut out = serde_json::Map::new();
        let rows = stmt
            .query_map(params_from_iter(p.iter().map(|b| b.as_ref())), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .filter_map(Result::ok);
        for (cid, last_read, count, mentions) in rows {
            out.insert(
                cid,
                json!({"count": count, "mentions": mentions, "last_read_id": last_read}),
            );
        }
        Value::Object(out)
    }

    // ---------------------------------------------------------- mentions

    /// Record which users a message @mentioned (called by the hub at post
    /// time with already-matched usernames).
    pub fn add_mentions(&self, message_id: i64, channel_id: &str, usernames: &[String]) {
        if usernames.is_empty() {
            return;
        }
        let conn = self.conn.lock().unwrap();
        for user in usernames {
            conn.execute(
                "INSERT INTO mentions (message_id, channel_id, username) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(message_id, username) DO NOTHING",
                params![message_id, channel_id, user],
            )
            .unwrap();
        }
    }

    // ------------------------------------------------------- thread reads

    /// Advance the user's per-thread read marker (None = thread max id).
    /// Monotonic like `mark_read`. Returns the effective marker.
    pub fn mark_thread_read(
        &self,
        username: &str,
        thread_id: i64,
        message_id: Option<i64>,
    ) -> i64 {
        let conn = self.conn.lock().unwrap();
        let target = match message_id {
            Some(id) => id.max(0),
            None => conn
                .query_row(
                    "SELECT COALESCE(MAX(id), 0) FROM messages WHERE thread_id = ?1",
                    params![thread_id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0),
        };
        conn.execute(
            "INSERT INTO thread_reads (username, thread_id, last_read_id, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(username, thread_id) DO UPDATE SET \
             last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at",
            params![username, thread_id, target, now()],
        )
        .unwrap();
        conn.query_row(
            "SELECT last_read_id FROM thread_reads WHERE username = ?1 AND thread_id = ?2",
            params![username, thread_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Dismiss a thread from the user's inbox/sidebar. The messages stay in
    /// the channel; the row just stops coming back from `my_threads`.
    pub fn hide_thread(&self, username: &str, thread_id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO thread_hides (username, thread_id, hidden_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(username, thread_id) DO NOTHING",
            params![username, thread_id, now()],
        )
        .unwrap();
    }

    pub fn unhide_thread(&self, username: &str, thread_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM thread_hides WHERE username = ?1 AND thread_id = ?2",
            params![username, thread_id],
        )
        .unwrap()
            > 0
    }

    /// The user's threads inbox: every thread they participate in (authored
    /// the root or any reply), newest activity first, minus threads they
    /// dismissed. Each row is the root message plus channel/group names,
    /// reply stats, and the user's unread reply count (own replies excluded).
    pub fn my_threads(&self, username: &str, limit: usize) -> Vec<Value> {
        let rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT r.id, r.channel_id, r.thread_id, r.author_type, r.author_id, \
                       r.author_name, r.text, r.ts, r.meta, \
                       c.name, c.group_id, COALESCE(g.name, ''), \
                       COUNT(m.id), MAX(m.id), MAX(m.ts), \
                       COALESCE(tr.last_read_id, 0), \
                       SUM(CASE WHEN m.id > COALESCE(tr.last_read_id, 0) \
                             AND NOT (m.author_type = 'user' AND m.author_id = ?1) \
                           THEN 1 ELSE 0 END), \
                       r.thread_alias \
                     FROM messages r \
                     JOIN channels c ON c.id = r.channel_id \
                     LEFT JOIN groups g ON g.id = c.group_id \
                     JOIN messages m ON m.thread_id = r.id \
                     LEFT JOIN thread_reads tr ON tr.username = ?1 AND tr.thread_id = r.id \
                     WHERE r.thread_id IS NULL AND ( \
                       (r.author_type = 'user' AND r.author_id = ?1) \
                       OR EXISTS (SELECT 1 FROM messages p WHERE p.thread_id = r.id \
                            AND p.author_type = 'user' AND p.author_id = ?1)) \
                     AND NOT EXISTS (SELECT 1 FROM thread_hides h \
                            WHERE h.username = ?1 AND h.thread_id = r.id) \
                     GROUP BY r.id ORDER BY MAX(m.id) DESC LIMIT ?2",
                )
                .unwrap();
            stmt.query_map(params![username, limit as i64], |r| {
                let mut root = message_row(r, 0)?;
                root["reply_count"] = json!(r.get::<_, i64>(12)?);
                root["alias"] = json!(r.get::<_, Option<String>>(17)?);
                Ok(json!({
                    "root": root,
                    "channel_id": r.get::<_, String>(1)?,
                    "channel_name": r.get::<_, String>(9)?,
                    "group_id": r.get::<_, String>(10)?,
                    "group_name": r.get::<_, String>(11)?,
                    "reply_count": r.get::<_, i64>(12)?,
                    "last_reply_id": r.get::<_, i64>(13)?,
                    "last_reply_ts": r.get::<_, f64>(14)?,
                    "last_read_id": r.get::<_, i64>(15)?,
                    "unread": r.get::<_, i64>(16)?,
                }))
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect()
        };
        rows
    }

    // ------------------------------------------------------------- pins

    pub fn pin_message(&self, channel_id: &str, message_id: i64, pinned_by: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO pins (channel_id, message_id, pinned_by, pinned_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(channel_id, message_id) DO NOTHING",
            params![channel_id, message_id, pinned_by, now()],
        )
        .unwrap()
            > 0
    }

    pub fn unpin_message(&self, channel_id: &str, message_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM pins WHERE channel_id = ?1 AND message_id = ?2",
            params![channel_id, message_id],
        )
        .unwrap()
            > 0
    }

    pub fn pin_count(&self, channel_id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM pins WHERE channel_id = ?1",
            params![channel_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    pub fn channel_pins(&self, channel_id: &str) -> Vec<Value> {
        let rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT m.id, m.channel_id, m.thread_id, m.author_type, m.author_id, \
                     m.author_name, m.text, m.ts, m.meta, p.pinned_by, p.pinned_at, \
                     (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id) \
                     FROM pins p JOIN messages m ON m.id = p.message_id \
                     WHERE p.channel_id = ?1 ORDER BY p.pinned_at DESC",
                )
                .unwrap();
            stmt.query_map(params![channel_id], |r| {
                let mut msg = message_row(r, 0)?;
                msg["pinned_by"] = json!(r.get::<_, Option<String>>(9)?);
                msg["pinned_at"] = json!(r.get::<_, f64>(10)?);
                msg["reply_count"] = json!(r.get::<_, i64>(11)?);
                Ok(msg)
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect()
        };
        self.attach_files(rows)
    }

    // ------------------------------------------------------------- agents

    /// Remember an agent seen on a connection (upsert; refreshes name/flags).
    pub fn upsert_agent(
        &self,
        id: &str,
        name: &str,
        source: &str,
        requires_mention: bool,
        has_avatar: bool,
        avatar_v: i64,
    ) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agents (id, name, source, requires_mention, last_seen, has_avatar, avatar_v) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = excluded.source, \
             requires_mention = excluded.requires_mention, last_seen = excluded.last_seen, \
             has_avatar = excluded.has_avatar, avatar_v = excluded.avatar_v",
            params![id, name, source, requires_mention as i64, now(), has_avatar as i64, avatar_v],
        )
        .unwrap();
    }

    pub fn known_agents(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, source, requires_mention, last_seen, has_avatar, avatar_v \
                 FROM agents ORDER BY name",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                "source": r.get::<_, String>(2)?,
                "requires_mention": r.get::<_, i64>(3)? != 0,
                "last_seen": r.get::<_, f64>(4)?,
                "has_avatar": r.get::<_, i64>(5)? != 0,
                "avatar_v": r.get::<_, i64>(6)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn agent(&self, id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, source, requires_mention, last_seen, has_avatar, avatar_v \
             FROM agents WHERE id = ?1",
            params![id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                    "source": r.get::<_, String>(2)?,
                    "requires_mention": r.get::<_, i64>(3)? != 0,
                    "last_seen": r.get::<_, f64>(4)?,
                    "has_avatar": r.get::<_, i64>(5)? != 0,
                    "avatar_v": r.get::<_, i64>(6)?,
                }))
            },
        )
        .ok()
    }

    pub fn remove_agent(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM agent_dm_grants WHERE agent_id = ?1", params![id]).unwrap();
        conn.execute("DELETE FROM agent_dm_policies WHERE agent_id = ?1", params![id]).unwrap();
        conn.execute("DELETE FROM agents WHERE id = ?1", params![id]).unwrap() > 0
    }

    // ------------------------------------------------------------- push tokens

    /// Register (or refresh) a device token under its owning account. A token
    /// moving between accounts (shared device, new sign-in) re-homes to the
    /// latest owner.
    pub fn upsert_push_token(&self, username: &str, token: &str, platform: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO push_tokens (token, platform, username, updated_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, \
             username = excluded.username, updated_at = excluded.updated_at",
            params![token, platform, username, now()],
        )
        .unwrap();
    }

    pub fn delete_push_token(&self, token: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM push_tokens WHERE token = ?1", params![token]).unwrap() > 0
    }

    pub fn list_push_tokens(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT token FROM push_tokens").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    /// Device tokens that should receive a push for a message in *channel_id*:
    /// tokens owned by enabled accounts that can see the channel — members of
    /// its group, or instance admins (who, like privileged sockets, see
    /// everything). `exclude_user` skips the author's own devices.
    pub fn push_tokens_for_channel(
        &self,
        channel_id: &str,
        exclude_user: Option<&str>,
    ) -> Vec<String> {
        let Some(chan) = self.channel(channel_id) else {
            return Vec::new();
        };
        if chan["kind"] == "agent_dm" {
            let owner = chan["dm_user_id"].as_str().unwrap_or_default();
            if exclude_user == Some(owner) { return Vec::new(); }
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT pt.token FROM push_tokens pt JOIN users u ON u.username = pt.username WHERE pt.username = ?1 AND u.disabled = 0").unwrap();
            return stmt.query_map(params![owner], |r| r.get::<_, String>(0)).unwrap().filter_map(Result::ok).collect();
        }
        let group_id = chan["group_id"].as_str().unwrap_or_default().to_string();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT pt.token FROM push_tokens pt \
                 JOIN users u ON u.username = pt.username \
                 WHERE u.disabled = 0 AND u.username != ?1 \
                 AND (u.instance_role = 'admin' OR EXISTS ( \
                     SELECT 1 FROM memberships m WHERE m.group_id = ?2 \
                     AND m.member_type = 'user' AND m.member_id = u.username \
                     AND (m.channel_id = '' OR m.channel_id = ?3)))",
            )
            .unwrap();
        stmt.query_map(params![exclude_user.unwrap_or(""), group_id, channel_id], |r| {
            r.get::<_, String>(0)
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// Give tokens registered before accounts existed (username = '') to the
    /// migrated single user, so their devices keep receiving pushes.
    pub fn claim_unowned_push_tokens(&self, username: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE push_tokens SET username = ?1 WHERE username = ''",
            params![username],
        )
        .unwrap();
    }
}

/// thread_reads/thread_hides have no channel_id column; scope the delete via
/// the thread's root message. Must run before the channel's messages are
/// deleted.
fn delete_thread_reads_for_channel(conn: &Connection, channel_id: &str) {
    for table in ["thread_reads", "thread_hides"] {
        conn.execute(
            &format!(
                "DELETE FROM {table} WHERE thread_id IN \
                 (SELECT id FROM messages WHERE channel_id = ?1)"
            ),
            params![channel_id],
        )
        .unwrap();
    }
}

fn insert_member(
    conn: &Connection,
    group_id: &str,
    channel_id: Option<&str>,
    member_type: &str,
    member_id: &str,
    role: &str,
) {
    conn.execute(
        "INSERT INTO memberships (group_id, channel_id, member_type, member_id, role, added_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(group_id, channel_id, member_type, member_id) DO UPDATE SET role = excluded.role",
        params![group_id, channel_id.unwrap_or(""), member_type, member_id, role, now()],
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    fn disk_store() -> (Store, TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("agora.db")).unwrap();
        (store, dir)
    }

    fn attachment(name: &str) -> NewAttachment {
        NewAttachment {
            filename: name.into(),
            mime: "text/plain".into(),
            data: format!("contents of {name}").into_bytes(),
        }
    }

    fn attachment_id(message: &Value) -> String {
        message["attachments"][0]["id"].as_str().unwrap().to_string()
    }

    fn assert_attachment_deleted(store: &Store, file_id: &str) {
        assert!(store.file(file_id).is_none());
        assert!(!store.file_path(file_id).exists());
    }

    fn assert_attachment_kept(store: &Store, file_id: &str) {
        assert!(store.file(file_id).is_some());
        assert!(store.file_path(file_id).exists());
    }

    #[test]
    fn group_channel_crud_and_cascade() {
        let s = store();
        let g = s.create_group("Health", "fitness stuff", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        assert!(gid.starts_with("health-"));
        assert!(s.user_is_group_admin("tom", gid));
        let c = s.create_channel(gid, "workouts", "daily");
        let cid = c["id"].as_str().unwrap();
        s.add_message(cid, "hello", "user", "tom", Some("Tom"), None, &[]);
        s.create_message_template("tom", gid, "Daily", "Daily update", 50)
            .unwrap();
        assert_eq!(s.messages(cid, None, None, 50).len(), 1);
        assert!(s.delete_group(gid));
        assert!(s.group(gid).is_none());
        assert!(s.channel(cid).is_none());
        assert_eq!(s.messages(cid, None, None, 50).len(), 0);
        assert!(s.message_templates("tom", gid).is_empty());
    }

    #[test]
    fn message_templates_are_private_group_scoped_and_stably_ordered() {
        let s = store();
        let g1 = s.create_group("One", "", Some("tom"));
        let g2 = s.create_group("Two", "", Some("tom"));
        let a = s.create_message_template("tom", g1["id"].as_str().unwrap(), "First", "alpha", 50).unwrap().unwrap();
        let b = s.create_message_template("tom", g1["id"].as_str().unwrap(), "Second", "beta", 50).unwrap().unwrap();
        s.create_message_template("ana", g1["id"].as_str().unwrap(), "Other", "private", 50)
            .unwrap();
        s.create_message_template("tom", g2["id"].as_str().unwrap(), "Elsewhere", "hidden", 50)
            .unwrap();
        assert_eq!(s.message_templates("tom", g1["id"].as_str().unwrap()).len(), 2);
        assert!(s.message_templates("ana", g2["id"].as_str().unwrap()).is_empty());
        let updated = s.update_message_template(a["id"].as_str().unwrap(), "tom", g1["id"].as_str().unwrap(), "First edit", "changed").unwrap();
        assert_eq!(updated["text"], "changed");
        let rows = s.message_templates("tom", g1["id"].as_str().unwrap());
        assert_eq!(rows[0]["id"], a["id"]);
        assert_eq!(rows[1]["id"], b["id"]);
        assert!(s.update_message_template(a["id"].as_str().unwrap(), "ana", g1["id"].as_str().unwrap(), "x", "x").is_none());
        assert!(s.delete_message_template(b["id"].as_str().unwrap(), "tom", g1["id"].as_str().unwrap()));
    }

    #[test]
    fn delete_user_data_sweeps_everything_user_keyed() {
        let (s, _dir) = disk_store();
        let g = s.create_group("Health", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();

        // Tom starts a thread (with an attachment); an agent replies in it and
        // also posts its own top-level message that Tom stars/pins/mentions.
        let att = NewAttachment {
            filename: "note.txt".into(),
            mime: "text/plain".into(),
            data: b"hello".to_vec(),
        };
        let root = s.add_message(cid, "mine", "user", "tom", Some("Tom"), None, &[att]);
        let root_id = root["id"].as_i64().unwrap();
        s.add_message(cid, "reply", "agent", "bot", Some("Bot"), Some(root_id), &[]);
        let other = s.add_message(
            cid,
            "agent news",
            "agent",
            "bot",
            Some("Bot"),
            None,
            &[attachment("surviving.txt")],
        );
        let other_id = other["id"].as_i64().unwrap();
        let other_file_id = attachment_id(&other);
        s.star_message("tom", cid, other_id);
        s.pin_message(cid, other_id, Some("tom"));
        s.add_mentions(other_id, cid, &["tom".to_string()]);
        s.mark_read("tom", cid, Some(other_id));
        s.mark_thread_read("tom", root_id, Some(root_id));
        s.hide_thread("tom", root_id);
        s.create_message_template("tom", gid, "Mine", "private draft", 50)
            .unwrap();
        let file_id = root["attachments"][0]["id"].as_str().unwrap().to_string();
        assert_attachment_kept(&s, &file_id);

        s.delete_user_data("tom");
        assert!(s.message_templates("tom", gid).is_empty());

        // Tom's thread is gone whole (root + agent reply); the agent's own
        // top-level message survives.
        assert!(s.message(root_id).is_none());
        let remaining = s.messages(cid, None, None, 50);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["id"].as_i64().unwrap(), other_id);
        assert_attachment_deleted(&s, &file_id);
        assert_attachment_kept(&s, &other_file_id);
        // FTS no longer finds the deleted text.
        assert!(s.search_messages("mine", false, None, None, None, None, None, false, 10, 0).is_empty());

        // Every user-keyed row is gone; group provenance is cleared.
        assert!(s.user_stars("tom", cid).is_empty());
        assert!(s.channel_pins(cid).is_empty());
        assert!(s.my_threads("tom", 50).is_empty());
        assert!(!s.user_in_group("tom", gid));
        assert!(s.group(gid).unwrap()["created_by"].is_null());
    }

    #[test]
    fn delete_message_cascades_thread_and_keyed_rows() {
        let s = store();
        let g = s.create_group("Team", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();

        let att = NewAttachment {
            filename: "note.txt".into(),
            mime: "text/plain".into(),
            data: b"hello".to_vec(),
        };
        let root = s.add_message(cid, "root", "user", "tom", Some("Tom"), None, &[att]);
        let root_id = root["id"].as_i64().unwrap();
        let reply = s.add_message(cid, "reply", "agent", "bot", Some("Bot"), Some(root_id), &[]);
        let reply_id = reply["id"].as_i64().unwrap();
        let keeper = s.add_message(cid, "keeper", "user", "tom", None, None, &[]);
        let keeper_id = keeper["id"].as_i64().unwrap();
        s.pin_message(cid, root_id, Some("tom"));
        s.star_message("tom", cid, reply_id);
        s.add_reaction("tom", cid, root_id, "👍");
        s.add_mentions(reply_id, cid, &["tom".to_string()]);
        s.mark_thread_read("tom", root_id, Some(reply_id));
        let file_id = root["attachments"][0]["id"].as_str().unwrap().to_string();

        // A reply goes alone; its starred row goes with it.
        assert!(s.delete_message(reply_id));
        assert!(s.message(reply_id).is_none());
        assert!(s.message(root_id).is_some());
        assert!(s.user_stars("tom", cid).is_empty());

        // A root sweeps its whole thread: attachment file, pin, read marker.
        assert!(s.delete_message(root_id));
        assert!(s.message(root_id).is_none());
        assert!(s.file(&file_id).is_none());
        assert!(s.channel_pins(cid).is_empty());
        assert!(s.my_threads("tom", 50).is_empty());
        let remaining = s.messages(cid, None, None, 50);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["id"].as_i64().unwrap(), keeper_id);
        // FTS no longer finds the deleted text.
        assert!(s.search_messages("root", false, None, None, None, None, None, false, 10, 0).is_empty());

        // Already gone: false, and nothing else is disturbed.
        assert!(!s.delete_message(root_id));
        assert_eq!(s.messages(cid, None, None, 50).len(), 1);
    }

    #[test]
    fn deleting_thread_removes_root_and_reply_attachment_bytes_only() {
        let (s, _dir) = disk_store();
        let group = s.create_group("Team", "", Some("tom"));
        let channel = s.create_channel(group["id"].as_str().unwrap(), "main", "");
        let channel_id = channel["id"].as_str().unwrap();
        let root = s.add_message(
            channel_id,
            "root",
            "user",
            "tom",
            Some("Tom"),
            None,
            &[attachment("root.txt")],
        );
        let root_id = root["id"].as_i64().unwrap();
        let reply = s.add_message(
            channel_id,
            "reply",
            "agent",
            "bot",
            Some("Bot"),
            Some(root_id),
            &[attachment("reply.txt")],
        );
        let unrelated = s.add_message(
            channel_id,
            "unrelated",
            "user",
            "tom",
            Some("Tom"),
            None,
            &[attachment("unrelated.txt")],
        );
        let root_file = attachment_id(&root);
        let reply_file = attachment_id(&reply);
        let unrelated_file = attachment_id(&unrelated);
        assert_attachment_kept(&s, &root_file);
        assert_attachment_kept(&s, &reply_file);

        assert!(s.delete_message(root_id));

        assert_attachment_deleted(&s, &root_file);
        assert_attachment_deleted(&s, &reply_file);
        assert_attachment_kept(&s, &unrelated_file);
    }

    #[test]
    fn deleting_channel_removes_all_attachment_bytes_only_in_that_channel() {
        let (s, _dir) = disk_store();
        let group = s.create_group("Team", "", Some("tom"));
        let group_id = group["id"].as_str().unwrap();
        let doomed = s.create_channel(group_id, "doomed", "");
        let keeper = s.create_channel(group_id, "keeper", "");
        let doomed_id = doomed["id"].as_str().unwrap();
        let keeper_id = keeper["id"].as_str().unwrap();
        let root = s.add_message(
            doomed_id,
            "root",
            "user",
            "tom",
            None,
            None,
            &[attachment("root.txt")],
        );
        let reply = s.add_message(
            doomed_id,
            "reply",
            "agent",
            "bot",
            None,
            Some(root["id"].as_i64().unwrap()),
            &[attachment("reply.txt")],
        );
        let kept = s.add_message(
            keeper_id,
            "kept",
            "user",
            "tom",
            None,
            None,
            &[attachment("kept.txt")],
        );
        let root_file = attachment_id(&root);
        let reply_file = attachment_id(&reply);
        let kept_file = attachment_id(&kept);
        assert_attachment_kept(&s, &root_file);
        assert_attachment_kept(&s, &reply_file);

        assert!(s.delete_channel(doomed_id));

        assert_attachment_deleted(&s, &root_file);
        assert_attachment_deleted(&s, &reply_file);
        assert_attachment_kept(&s, &kept_file);
    }

    #[test]
    fn deleting_group_removes_all_attachment_bytes_and_reactions_only_in_that_group() {
        let (s, _dir) = disk_store();
        let doomed_group = s.create_group("Doomed", "", Some("tom"));
        let kept_group = s.create_group("Kept", "", Some("tom"));
        let doomed_group_id = doomed_group["id"].as_str().unwrap();
        let kept_group_id = kept_group["id"].as_str().unwrap();
        let first = s.create_channel(doomed_group_id, "first", "");
        let second = s.create_channel(doomed_group_id, "second", "");
        let kept_channel = s.create_channel(kept_group_id, "kept", "");
        let first_id = first["id"].as_str().unwrap();
        let second_id = second["id"].as_str().unwrap();
        let kept_channel_id = kept_channel["id"].as_str().unwrap();
        let root = s.add_message(
            first_id,
            "root",
            "user",
            "tom",
            None,
            None,
            &[attachment("root.txt")],
        );
        let reply = s.add_message(
            first_id,
            "reply",
            "agent",
            "bot",
            None,
            Some(root["id"].as_i64().unwrap()),
            &[attachment("reply.txt")],
        );
        let second_message = s.add_message(
            second_id,
            "second",
            "user",
            "tom",
            None,
            None,
            &[attachment("second.txt")],
        );
        let kept = s.add_message(
            kept_channel_id,
            "kept",
            "user",
            "tom",
            None,
            None,
            &[attachment("kept.txt")],
        );
        s.add_reaction("tom", first_id, root["id"].as_i64().unwrap(), "👍");
        s.add_reaction("tom", kept_channel_id, kept["id"].as_i64().unwrap(), "👍");
        let deleted_files = [
            attachment_id(&root),
            attachment_id(&reply),
            attachment_id(&second_message),
        ];
        let kept_file = attachment_id(&kept);
        for file_id in &deleted_files {
            assert_attachment_kept(&s, file_id);
        }

        assert!(s.delete_group(doomed_group_id));

        for file_id in &deleted_files {
            assert_attachment_deleted(&s, file_id);
        }
        assert_attachment_kept(&s, &kept_file);
        let reaction_channels: Vec<String> = {
            let conn = s.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT channel_id FROM reactions").unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        assert_eq!(reaction_channels, vec![kept_channel_id.to_string()]);
    }

    #[test]
    fn membership_scoping() {
        let s = store();
        let g = s.create_group("Ops", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c1 = s.create_channel(gid, "alpha", "");
        let c2 = s.create_channel(gid, "beta", "");
        let c1id = c1["id"].as_str().unwrap();
        let c2id = c2["id"].as_str().unwrap();
        s.add_member(gid, "agent", "bot-a", "member", None); // whole group
        s.add_member(gid, "agent", "bot-b", "member", Some(c1id)); // one channel
        assert_eq!(s.agents_for_channel(c1id).len(), 2);
        assert_eq!(s.agents_for_channel(c2id), vec!["bot-a".to_string()]);
        assert!(s.agent_in_channel("bot-a", c1id));
        assert!(s.agent_in_channel("bot-a", c2id));
        assert!(s.agent_in_channel("bot-b", c1id));
        assert!(!s.agent_in_channel("bot-b", c2id));
        assert!(!s.agent_in_channel("missing", c1id));
        assert!(s.user_in_group("tom", gid));
        assert!(!s.user_in_group("alice", gid));
        s.add_member(gid, "user", "alice", "member", None);
        s.create_message_template("alice", gid, "Standup", "Status update", 50)
            .unwrap();
        s.remove_member(gid, "user", "alice", None);
        assert_eq!(s.message_templates("alice", gid).len(), 1);

        // Membership never crosses groups: a group-wide row in Ops grants
        // nothing in another group, and a row whose channel_id points at a
        // channel of a *different* group must not match either.
        let g2 = s.create_group("Eng", "", Some("tom"));
        let g2id = g2["id"].as_str().unwrap();
        let c3 = s.create_channel(g2id, "gamma", "");
        let c3id = c3["id"].as_str().unwrap();
        assert!(!s.agent_in_channel("bot-a", c3id));
        s.add_member(g2id, "agent", "bot-c", "member", Some(c1id));
        assert!(!s.agent_in_channel("bot-c", c1id));
        assert!(!s.agent_in_channel("bot-c", c3id));
    }

    #[test]
    fn user_membership_scopes_roles_and_normalization() {
        let s = Store::open_in_memory().unwrap();
        s.create_user("alice", "Alice", None, "member").unwrap();
        let g = s.create_group("Private", "", None);
        let gid = g["id"].as_str().unwrap();
        let c1 = s.create_channel(gid, "one", "");
        let c2 = s.create_channel(gid, "two", "");
        let c1id = c1["id"].as_str().unwrap();
        let c2id = c2["id"].as_str().unwrap();

        s.add_member(gid, "user", "alice", "admin", Some(c1id));
        assert!(s.user_can_access_group("alice", gid));
        assert!(s.user_can_see_channel("alice", c1id));
        assert!(!s.user_can_see_channel("alice", c2id));
        assert!(s.user_is_channel_admin("alice", c1id));
        assert!(!s.user_is_group_admin("alice", gid));

        s.add_member(gid, "user", "alice", "member", None);
        assert!(s.user_can_see_channel("alice", c2id));
        assert_eq!(s.members(gid).iter().filter(|m| m["member_id"] == "alice").count(), 1);
        // Narrow rows are no-ops while whole-group access exists.
        s.add_member(gid, "user", "alice", "admin", Some(c1id));
        assert_eq!(s.members(gid).iter().filter(|m| m["member_id"] == "alice").count(), 1);
        assert!(s.remove_member_all(gid, "user", "alice"));
        assert!(!s.user_can_access_group("alice", gid));

        s.set_group_public(gid, true);
        s.add_member(gid, "user", "alice", "member", Some(c1id));
        assert!(s.user_can_see_channel("alice", c1id));
        assert!(s.user_can_see_channel("alice", c2id), "a scoped row must not narrow a public group");
        s.delete_channel(c1id);
        assert!(s.members(gid).iter().all(|m| m["channel_id"] != c1id));
    }

    #[test]
    fn public_groups_grant_access_without_membership() {
        let s = store();
        let g = s.create_group("Commons", "open to all", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "lobby", "");
        let cid = c["id"].as_str().unwrap();
        s.add_message(cid, "welcome aboard", "user", "tom", None, None, &[]);

        // Members-only by default.
        assert_eq!(g["is_public"], false);
        assert!(!s.user_can_access_group("alice", gid));
        assert!(!s.user_can_see_channel("alice", cid));
        assert!(s.search_groups("Commons", Some("alice"), 10).is_empty());
        assert!(s.search_channels("lobby", Some("alice"), 10).is_empty());
        assert!(s
            .search_messages("welcome", false, None, None, None, None, Some("alice"), false, 10, 0)
            .is_empty());

        // Public: member-level access for everyone; raw membership and the
        // admin role are untouched.
        let g = s.set_group_public(gid, true).unwrap();
        assert_eq!(g["is_public"], true);
        assert!(s.user_can_access_group("alice", gid));
        assert!(s.user_can_see_channel("alice", cid));
        assert!(!s.user_in_group("alice", gid));
        assert!(!s.user_is_group_admin("alice", gid));
        assert_eq!(s.search_groups("Commons", Some("alice"), 10).len(), 1);
        assert_eq!(s.search_channels("lobby", Some("alice"), 10).len(), 1);
        assert_eq!(
            s.search_messages("welcome", false, None, None, None, None, Some("alice"), false, 10, 0)
                .len(),
            1
        );

        // Flip back: access revoked again.
        let g = s.set_group_public(gid, false).unwrap();
        assert_eq!(g["is_public"], false);
        assert!(!s.user_can_access_group("alice", gid));
        assert!(s.search_groups("Commons", Some("alice"), 10).is_empty());

        // Unknown group: no row, no panic.
        assert!(s.set_group_public("nope", true).is_none());
    }

    #[test]
    fn threads_and_reply_counts() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        s.add_message(cid, "reply1", "agent", "bot", Some("Bot"), Some(root_id), &[]);
        s.add_message(cid, "reply2", "user", "tom", None, Some(root_id), &[]);
        let top = s.messages(cid, None, None, 50);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0]["reply_count"], 2);
        let thread = s.messages(cid, Some(root_id), None, 50);
        assert_eq!(thread.len(), 2);
        assert_eq!(s.thread_size(root_id), 2);
    }

    #[test]
    fn rename_thread_sets_clears_and_rejects_non_roots() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        let reply = s.add_message(cid, "reply", "user", "tom", None, Some(root_id), &[]);
        let reply_id = reply["id"].as_i64().unwrap();

        // Set an alias — it comes back on the message, in the inbox row, and
        // on the root's row in channel pages (which feed open thread headers).
        let updated = s.rename_thread(root_id, Some("Launch plan")).unwrap();
        assert_eq!(updated["alias"], "Launch plan");
        let rows = s.my_threads("tom", 50);
        assert_eq!(rows[0]["root"]["alias"], "Launch plan");
        let page = s.messages(cid, None, None, 50);
        assert_eq!(page[0]["alias"], "Launch plan");
        assert_eq!(s.message(root_id).unwrap()["alias"], "Launch plan");
        // Replies never carry an alias key value.
        assert!(s.messages(cid, Some(root_id), None, 50)[0]["alias"].is_null());

        // Clearing it drops back to null.
        let cleared = s.rename_thread(root_id, None).unwrap();
        assert!(cleared["alias"].is_null());
        assert!(s.my_threads("tom", 50)[0]["root"]["alias"].is_null());

        // A reply id isn't a thread root — refuse it.
        assert!(s.rename_thread(reply_id, Some("nope")).is_none());
        assert!(s.rename_thread(999_999, Some("nope")).is_none());
    }

    #[test]
    fn fts_query_quotes_terms_and_neutralizes_syntax() {
        assert_eq!(fts_query("hello world"), Some("\"hello\" \"world\"*".into()));
        assert_eq!(fts_query("\"exact phrase\" tail"), Some("\"exact phrase\" \"tail\"*".into()));
        // Operators and column syntax arrive as inert quoted terms.
        assert_eq!(fts_query("a AND b:c -d"), Some("\"a\" \"AND\" \"b:c\" \"-d\"*".into()));
        assert_eq!(fts_query("   "), None);
        assert_eq!(fts_query("\"\""), None);
    }

    #[test]
    fn search_messages_matches_stems_scopes_and_syncs() {
        let s = store();
        let g = s.create_group("Ops", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c1 = s.create_channel(gid, "alpha", "");
        let c2 = s.create_channel(gid, "beta", "");
        let c1id = c1["id"].as_str().unwrap();
        let c2id = c2["id"].as_str().unwrap();
        s.add_message(c1id, "we deployed the new build", "user", "tom", Some("Tom"), None, &[]);
        s.add_message(c2id, "the bot deploys on fridays", "agent", "bot", Some("Bot"), None, &[]);
        s.add_message(c2id, "unrelated chatter", "user", "tom", None, None, &[]);

        // Porter stemming: "deploy" finds both variants; hits carry names + snippet.
        let hits = s.search_messages("deploy", false, None, None, None, None, None, false, 10, 0);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["group_name"], "Ops");
        assert!(hits[0]["channel_name"].as_str().is_some());
        assert!(hits[0]["snippet"].as_str().unwrap().contains('\u{1}'));

        // Channel and author scoping.
        assert_eq!(s.search_messages("deploy", false, Some(c1id), None, None, None, None, false, 10, 0).len(), 1);
        assert_eq!(s.search_messages("deploy", false, None, Some(gid), None, None, None, false, 10, 0).len(), 2);
        assert_eq!(s.search_messages("deploy", false, None, None, Some("bot"), None, None, false, 10, 0).len(), 1);

        // Agent visibility: bot-b is only in beta, so alpha's hit is invisible.
        s.add_member(gid, "agent", "bot-b", "member", Some(c2id));
        let scoped = s.search_messages("deploy", false, None, None, None, Some("bot-b"), None, false, 10, 0);
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0]["channel_id"].as_str().unwrap(), c2id);

        // newest_first orders by id descending.
        let newest = s.search_messages("deploy", false, None, None, None, None, None, true, 10, 0);
        assert!(newest[0]["id"].as_i64().unwrap() > newest[1]["id"].as_i64().unwrap());

        // A raw query full of FTS syntax must not panic, just match nothing.
        assert!(s.search_messages("AND NOT (", false, None, None, None, None, None, false, 10, 0).is_empty());

        // match_any: recall mode hits messages containing either word
        // ("deployed" stems onto "deploys" too, so all three rows hit).
        let any = s.search_messages("deployed chatter", true, None, None, None, None, None, false, 10, 0);
        assert_eq!(any.len(), 3);

        // Deleting the group cascades into the index via the triggers.
        assert!(s.delete_group(gid));
        assert!(s.search_messages("deploy", false, None, None, None, None, None, false, 10, 0).is_empty());
    }

    #[test]
    fn search_matches_filenames_and_filters_by_attachment() {
        let s = store();
        let g = s.create_group("Work", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "ops", "");
        let cid = c["id"].as_str().unwrap();
        let file = |name: &str, mime: &str| NewAttachment {
            filename: name.into(),
            mime: mime.into(),
            data: b"bytes".to_vec(),
        };
        // A message whose text says nothing about the file it carries.
        s.add_message(cid, "here you go", "user", "tom", None, None, &[file("budget-2026.xlsx", "application/vnd.ms-excel")]);
        s.add_message(cid, "and the diagram", "user", "tom", None, None, &[file("floorplan.png", "image/png")]);
        s.add_message(cid, "no attachment here, just budget talk", "user", "tom", None, None, &[]);

        // Filename search: "budget" hits the .xlsx message *and* the text one.
        let by_name = s.search_messages("budget", false, None, None, None, None, None, false, 20, 0);
        assert_eq!(by_name.len(), 2);
        // The attachment array rides along on hits.
        let xlsx = by_name.iter().find(|m| m["text"] == "here you go").unwrap();
        assert_eq!(xlsx["attachments"][0]["filename"], "budget-2026.xlsx");

        // "floorplan" only exists as a filename — text search still finds it.
        let only_file = s.search_messages("floorplan", false, None, None, None, None, None, false, 20, 0);
        assert_eq!(only_file.len(), 1);
        assert_eq!(only_file[0]["text"], "and the diagram");

        // has_files filter drops the text-only "budget" message.
        let with_files = s.search_messages_ext("budget", false, None, None, None, None, None, false, true, None, 20, 0);
        assert_eq!(with_files.len(), 1);
        assert_eq!(with_files[0]["text"], "here you go");

        // file_type narrows to a kind (no query needed: browse mode).
        let images = s.search_messages_ext("", false, None, None, None, None, None, false, false, Some("image"), 20, 0);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["attachments"][0]["filename"], "floorplan.png");

        // Browse every attachment, newest first.
        let all = s.search_messages_ext("", false, None, None, None, None, None, false, true, None, 20, 0);
        assert_eq!(all.len(), 2);
        assert!(all[0]["id"].as_i64().unwrap() > all[1]["id"].as_i64().unwrap());

        // Empty query with no attachment filter still matches nothing.
        assert!(s.search_messages("", false, None, None, None, None, None, false, 20, 0).is_empty());
    }

    #[test]
    fn search_backfills_history_from_a_pre_index_database() {
        // A database written before the FTS index existed: old schema, no
        // messages_fts, no triggers, user_version 0 — like any live install
        // upgrading to the search release. Opening it must backfill the index
        // so pre-existing history is searchable, not just new writes.
        let dir = std::env::temp_dir().join(format!("agora_fts_migrate_{}", new_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agora.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, \
                   description TEXT NOT NULL DEFAULT '', created_by TEXT, \
                   created_at REAL NOT NULL, position INTEGER NOT NULL DEFAULT 0, \
                   hidden INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE channels (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, \
                   name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', \
                   created_at REAL NOT NULL, position INTEGER NOT NULL DEFAULT 0, \
                   hidden INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, \
                   channel_id TEXT NOT NULL, thread_id INTEGER, author_type TEXT NOT NULL, \
                   author_id TEXT NOT NULL, author_name TEXT, text TEXT NOT NULL, \
                   ts REAL NOT NULL, meta TEXT);
                 INSERT INTO groups VALUES ('g1', 'Home', '', NULL, 0, 0, 0);
                 INSERT INTO channels VALUES ('c1', 'g1', 'pets', '', 0, 0, 0);
                 INSERT INTO messages (channel_id, author_type, author_id, text, ts) \
                   VALUES ('c1', 'user', 'me', 'my pet turtle escaped', 0);",
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        let hits = s.search_messages("pet", false, None, None, None, None, None, false, 10, 0);
        assert_eq!(hits.len(), 1, "pre-index history must be backfilled");
        assert_eq!(hits[0]["text"], "my pet turtle escaped");
        // Reopening doesn't rebuild again (version marker advanced) but the
        // index still works, triggers included.
        drop(s);
        let s = Store::open(&path).unwrap();
        s.add_message("c1", "the pet is back", "user", "me", None, None, &[]);
        assert_eq!(s.search_messages("pet", false, None, None, None, None, None, false, 10, 0).len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_channels_and_groups_by_name_topic_description() {
        let s = store();
        let g = s.create_group("Health", "fitness and 100% wellness", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        s.create_channel(gid, "workouts", "daily training");
        s.create_channel(gid, "meals", "");

        assert_eq!(s.search_channels("WORK", None, 10).len(), 1); // case-insensitive name
        let by_topic = s.search_channels("training", None, 10);
        assert_eq!(by_topic.len(), 1);
        assert_eq!(by_topic[0]["group_name"], "Health");
        assert_eq!(s.search_groups("fitness", None, 10).len(), 1); // by description
        // LIKE wildcards in input are literal, not "match everything".
        assert!(s.search_channels("%", None, 10).is_empty());
        assert_eq!(s.search_groups("100%", None, 10).len(), 1);
        // Membership scoping: only a group member sees its channels/groups.
        assert_eq!(s.search_channels("WORK", Some("tom"), 10).len(), 1);
        assert!(s.search_channels("WORK", Some("mallory"), 10).is_empty());
        assert_eq!(s.search_groups("fitness", Some("tom"), 10).len(), 1);
        assert!(s.search_groups("fitness", Some("mallory"), 10).is_empty());
    }

    #[test]
    fn reads_monotonic_and_seeded() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let m1 = s.add_message(cid, "one", "agent", "bot", None, None, &[]);
        let id1 = m1["id"].as_i64().unwrap();
        s.add_message(cid, "two", "agent", "bot", None, None, &[]);
        // New member is seeded with everything read.
        s.add_member(gid, "user", "alice", "member", None);
        let unread = s.unread_counts("alice", &[cid.to_string()]);
        assert_eq!(unread[cid]["count"], 0);
        // tom created the group before messages existed: no seed row, all unread.
        let unread_tom = s.unread_counts("tom", &[cid.to_string()]);
        assert_eq!(unread_tom[cid]["count"], 2);
        let marker = s.mark_read("tom", cid, Some(id1));
        assert_eq!(marker, id1);
        // Stale ack cannot regress.
        assert_eq!(s.mark_read("tom", cid, Some(0)), id1);
        assert_eq!(s.unread_counts("tom", &[cid.to_string()])[cid]["count"], 1);
    }

    #[test]
    fn unread_counts_top_level_only_with_mentions() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "agent", "bot", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        // Thread replies don't inflate the channel badge...
        s.add_message(cid, "reply", "agent", "bot", None, Some(root_id), &[]);
        let m = s.add_message(cid, "hey @tom", "agent", "bot", None, Some(root_id), &[]);
        s.add_mentions(m["id"].as_i64().unwrap(), cid, &["tom".to_string()]);
        let u = s.unread_counts("tom", &[cid.to_string()]);
        assert_eq!(u[cid]["count"], 1); // just the root
        // ...but an @mention inside a thread still counts as a mention.
        assert_eq!(u[cid]["mentions"], 1);
        s.mark_read("tom", cid, None);
        let u = s.unread_counts("tom", &[cid.to_string()]);
        assert_eq!(u[cid]["count"], 0);
        assert_eq!(u[cid]["mentions"], 0);
    }

    #[test]
    fn thread_reads_monotonic() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        let r1 = s.add_message(cid, "r1", "agent", "bot", None, Some(root_id), &[]);
        s.add_message(cid, "r2", "agent", "bot", None, Some(root_id), &[]);
        let id1 = r1["id"].as_i64().unwrap();
        assert_eq!(s.mark_thread_read("tom", root_id, Some(id1)), id1);
        // Stale ack cannot regress; None advances to the thread max.
        assert_eq!(s.mark_thread_read("tom", root_id, Some(0)), id1);
        let max = s.mark_thread_read("tom", root_id, None);
        assert!(max > id1);
    }

    #[test]
    fn my_threads_participation_and_unreads() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        // Thread A: tom's root, bot replies -> participant with unreads.
        let a = s.add_message(cid, "mine", "user", "tom", None, None, &[]);
        let a_id = a["id"].as_i64().unwrap();
        s.add_message(cid, "re A", "agent", "bot", Some("Bot"), Some(a_id), &[]);
        // Thread B: bot root and replies only -> not tom's thread.
        let b = s.add_message(cid, "bots", "agent", "bot", None, None, &[]);
        let b_id = b["id"].as_i64().unwrap();
        s.add_message(cid, "re B", "agent", "bot2", None, Some(b_id), &[]);
        // Thread C: bot root, tom replied -> participant.
        let cmsg = s.add_message(cid, "topic", "agent", "bot", None, None, &[]);
        let c_id = cmsg["id"].as_i64().unwrap();
        s.add_message(cid, "me too", "user", "tom", None, Some(c_id), &[]);
        let threads = s.my_threads("tom", 50);
        let ids: Vec<i64> = threads.iter().map(|t| t["root"]["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![c_id, a_id]); // newest activity first, no thread B
        let thread_a = threads.iter().find(|t| t["root"]["id"] == a_id).unwrap();
        assert_eq!(thread_a["unread"], 1);
        assert_eq!(thread_a["channel_name"], "main");
        assert_eq!(thread_a["group_name"], "G");
        // Own reply in C is not unread to tom.
        let thread_c = threads.iter().find(|t| t["root"]["id"] == c_id).unwrap();
        assert_eq!(thread_c["unread"], 0);
        // Acking A clears its unread.
        s.mark_thread_read("tom", a_id, None);
        let threads = s.my_threads("tom", 50);
        let thread_a = threads.iter().find(|t| t["root"]["id"] == a_id).unwrap();
        assert_eq!(thread_a["unread"], 0);
    }

    #[test]
    fn manual_ordering() {
        let s = store();
        let a = s.create_group("Alpha", "", None);
        let b = s.create_group("Beta", "", None);
        let (aid, bid) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
        // Creation order is preserved (position auto-increments).
        let names: Vec<String> = s.list_groups().iter().map(|g| g["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["Alpha", "Beta"]);
        s.reorder_groups(&[bid.to_string(), aid.to_string()]);
        let names: Vec<String> = s.list_groups().iter().map(|g| g["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["Beta", "Alpha"]);
        let c1 = s.create_channel(aid, "zeta", "");
        let c2 = s.create_channel(aid, "acme", "");
        let (c1id, c2id) = (c1["id"].as_str().unwrap(), c2["id"].as_str().unwrap());
        let names: Vec<String> = s.group_channels(aid).iter().map(|c| c["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["zeta", "acme"]); // creation order, not alphabetical
        s.reorder_channels(aid, &[c2id.to_string(), c1id.to_string()]);
        let names: Vec<String> = s.group_channels(aid).iter().map(|c| c["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["acme", "zeta"]);
    }

    #[test]
    fn update_channel_name_and_topic() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "old", "old topic");
        let cid = c["id"].as_str().unwrap();
        let updated = s.update_channel(cid, Some("new"), None, None).unwrap();
        assert_eq!(updated["name"], "new");
        assert_eq!(updated["topic"], "old topic");
        let updated = s.update_channel(cid, None, Some("fresh topic"), None).unwrap();
        assert_eq!(updated["name"], "new");
        assert_eq!(updated["topic"], "fresh topic");
    }

    #[test]
    fn hide_groups_and_channels() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        assert_eq!(s.group(gid).unwrap()["hidden"], false);
        assert_eq!(s.channel(cid).unwrap()["hidden"], false);
        let hidden = s.set_group_hidden(gid, true).unwrap();
        assert_eq!(hidden["hidden"], true);
        assert_eq!(s.list_groups()[0]["hidden"], true);
        assert_eq!(s.set_group_hidden(gid, false).unwrap()["hidden"], false);
        assert!(s.set_group_hidden("nope", true).is_none());
        let updated = s.update_channel(cid, None, None, Some(true)).unwrap();
        assert_eq!(updated["hidden"], true);
        assert_eq!(updated["name"], "main"); // untouched
        assert_eq!(s.group_channels(gid)[0]["hidden"], true);
        assert_eq!(s.update_channel(cid, None, None, Some(false)).unwrap()["hidden"], false);
    }

    #[test]
    fn thread_hide_and_unhide() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "mine", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        s.add_message(cid, "re", "agent", "bot", None, Some(root_id), &[]);
        assert_eq!(s.my_threads("tom", 50).len(), 1);
        s.hide_thread("tom", root_id);
        s.hide_thread("tom", root_id); // idempotent
        assert!(s.my_threads("tom", 50).is_empty());
        // The messages themselves are untouched.
        assert_eq!(s.messages(cid, Some(root_id), None, 50).len(), 1);
        assert!(s.unhide_thread("tom", root_id));
        assert!(!s.unhide_thread("tom", root_id));
        assert_eq!(s.my_threads("tom", 50).len(), 1);
        // Channel delete sweeps hide rows too.
        s.hide_thread("tom", root_id);
        s.delete_channel(cid);
        let conn_count: i64 = {
            let conn = s.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM thread_hides", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(conn_count, 0);
    }

    #[test]
    fn mentions_cascade_with_channel_delete() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root @tom", "agent", "bot", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        s.add_mentions(root_id, cid, &["tom".to_string()]);
        s.mark_thread_read("tom", root_id, Some(5));
        s.delete_channel(cid);
        // Fresh channel with the same id space: no leftover state.
        let u = s.unread_counts("tom", &[cid.to_string()]);
        assert!(u[cid].is_null() || u[cid]["mentions"] == 0);
        assert!(s.my_threads("tom", 50).is_empty());
    }

    #[test]
    fn pins_and_stars() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let m = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();
        assert!(s.pin_message(cid, mid, Some("tom")));
        assert!(!s.pin_message(cid, mid, Some("tom"))); // idempotent
        assert_eq!(s.pin_count(cid), 1);
        assert_eq!(s.channel_pins(cid)[0]["id"], mid);
        assert!(s.unpin_message(cid, mid));
        assert!(s.star_message("tom", cid, mid));
        assert_eq!(s.user_stars("tom", cid).len(), 1);
        assert!(s.unstar_message("tom", mid));
        assert!(s.user_stars("tom", cid).is_empty());
    }

    #[test]
    fn reactions_toggle_and_aggregate() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let m = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();

        // Fresh messages carry an empty list so client merges can rely on it.
        assert_eq!(s.message(mid).unwrap()["reactions"], json!([]));

        assert!(s.add_reaction("tom", cid, mid, "👍"));
        assert!(!s.add_reaction("tom", cid, mid, "👍")); // idempotent
        assert!(s.add_reaction("ana", cid, mid, "👍"));
        assert!(s.add_reaction("ana", cid, mid, "🔥"));

        // Grouped in first-reaction order; users in reaction order.
        let reactions = s.message(mid).unwrap()["reactions"].clone();
        assert_eq!(reactions[0]["users"], json!(["tom", "ana"]));
        assert_eq!(reactions[0]["reactors"], json!([
            {"type": "user", "id": "tom", "name": "tom"},
            {"type": "user", "id": "ana", "name": "ana"}
        ]));
        assert_eq!(reactions[1]["users"], json!(["ana"]));

        // Removing the last user of an emoji drops the whole group.
        assert!(s.remove_reaction("ana", mid, "🔥"));
        assert!(!s.remove_reaction("ana", mid, "🔥")); // already gone
        assert_eq!(s.message(mid).unwrap()["reactions"].as_array().unwrap().len(), 1);

        // The list pages carry reactions too (attach_files hook).
        let page = s.messages(cid, None, None, 50);
        let row = page.iter().find(|x| x["id"] == mid).unwrap();
        assert_eq!(row["reactions"][0]["emoji"], "👍");
    }

    #[test]
    fn reactions_cascade_with_channel_delete_and_user_delete() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let m = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();
        s.add_reaction("tom", cid, mid, "👍");
        s.add_reaction("ana", cid, mid, "🎉");
        s.upsert_agent("agent-ana", "ana", "test", false, false, 0);
        s.add_agent_reaction("agent-ana", "ana", cid, mid, "👀");

        // A deleted user's reactions disappear from surviving messages.
        s.delete_user_data("ana");
        let remaining = s.message(mid).unwrap()["reactions"].clone();
        assert_eq!(remaining[0]["users"], json!(["tom"]));
        assert_eq!(remaining[1]["reactors"][0]["id"], "agent-ana");

        // Channel delete sweeps the rest.
        s.delete_channel(cid);
        let count: i64 = {
            let conn = s.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM reactions", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count, 0);
    }

    #[test]
    fn agent_reaction_stays_unique_across_display_name_changes() {
        let s = store();
        let g = s.create_group("G", "", None);
        let c = s.create_channel(g["id"].as_str().unwrap(), "main", "");
        let cid = c["id"].as_str().unwrap();
        let m = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();
        s.upsert_agent("bot-a", "Bot A", "test", false, false, 0);
        assert!(s.add_agent_reaction("bot-a", "Bot A", cid, mid, "👀"));
        s.upsert_agent("bot-a", "Bot Alpha", "test", false, false, 0);
        assert!(!s.add_agent_reaction("bot-a", "Bot Alpha", cid, mid, "👀"));
        let reaction = &s.message(mid).unwrap()["reactions"][0];
        assert_eq!(reaction["users"], json!(["Bot A"]));
        assert_eq!(reaction["reactors"], json!([
            {"type": "agent", "id": "bot-a", "name": "Bot Alpha"}
        ]));
    }

    #[test]
    fn legacy_key_allows_only_one_same_named_user_or_agent_reaction() {
        let s = store();
        s.create_user("Echo", "Echo Person", None, "member").unwrap();
        s.upsert_agent("echo-agent", "Echo", "test", false, false, 0);
        let g = s.create_group("G", "", None);
        let c = s.create_channel(g["id"].as_str().unwrap(), "main", "");
        let cid = c["id"].as_str().unwrap();
        let m = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();

        assert!(s.add_reaction("Echo", cid, mid, "👍"));
        assert!(!s.add_agent_reaction("echo-agent", "Echo", cid, mid, "👍"));
        assert_eq!(s.message(mid).unwrap()["reactions"][0]["reactors"], json!([
            {"type": "user", "id": "Echo", "name": "Echo Person"}
        ]));
    }

    #[test]
    fn reaction_migration_classifies_only_unambiguous_legacy_agents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let conn = Connection::open(&path).unwrap();
        let legacy = SCHEMA.replace("    reactor_type TEXT NOT NULL DEFAULT 'user',\n", "")
            .replace("    reactor_id TEXT NOT NULL DEFAULT '',\n", "");
        conn.execute_batch(&legacy).unwrap();
        conn.execute("INSERT INTO agents (id, name, last_seen) VALUES \
            ('solo-id', 'Solo', 0), ('bob-agent', 'bob', 0), \
            ('dup-a', 'Duplicate', 0), ('dup-b', 'Duplicate', 0)", []).unwrap();
        conn.execute("INSERT INTO users (username, display_name, created_at) VALUES ('bob', 'Bob', 0)", []).unwrap();
        conn.execute("INSERT INTO reactions (channel_id, message_id, username, emoji, reacted_at) VALUES \
            ('c', 1, 'Solo', '👀', 1), ('c', 1, 'bob', '👍', 2), \
            ('c', 1, 'Duplicate', '🎉', 3)", []).unwrap();
        drop(conn);
        let store = Store::open(&path).unwrap();
        let conn = store.conn.lock().unwrap();
        let solo: (String, String) = conn.query_row("SELECT reactor_type, reactor_id FROM reactions WHERE username = 'Solo'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let bob: (String, String) = conn.query_row("SELECT reactor_type, reactor_id FROM reactions WHERE username = 'bob'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        let duplicate: (String, String) = conn.query_row("SELECT reactor_type, reactor_id FROM reactions WHERE username = 'Duplicate'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(solo, ("agent".into(), "solo-id".into()));
        assert_eq!(bob, ("user".into(), "bob".into()));
        assert_eq!(duplicate, ("user".into(), "Duplicate".into()));
    }

    #[test]
    fn attachments_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("agora.db")).unwrap();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let att = NewAttachment {
            filename: "note.txt".into(),
            mime: "text/plain".into(),
            data: b"hello bytes".to_vec(),
        };
        let m = s.add_message(cid, "with file", "user", "tom", None, None, &[att]);
        let file_id = m["attachments"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(std::fs::read(s.file_path(&file_id)).unwrap(), b"hello bytes");
        let fetched = s.message(m["id"].as_i64().unwrap()).unwrap();
        assert_eq!(fetched["attachments"][0]["filename"], "note.txt");
        // Channel delete unlinks bytes.
        s.delete_channel(cid);
        assert!(!s.file_path(&file_id).exists());
    }

    #[test]
    fn attachment_browser_pages_files_and_deletes_only_one() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("agora.db")).unwrap();
        let g = s.create_group("G", "", None);
        let c = s.create_channel(g["id"].as_str().unwrap(), "main", "");
        let cid = c["id"].as_str().unwrap();
        let file = |name: &str| NewAttachment {
            filename: name.into(), mime: "text/plain".into(), data: name.as_bytes().to_vec(),
        };
        let root = s.add_message(
            cid, "Fallback thread name", "user", "tom", None, None,
            &[file("one.txt"), file("two.txt")],
        );
        let root_id = root["id"].as_i64().unwrap();
        s.rename_thread(root_id, Some("Renamed thread"));
        s.add_message(cid, "reply", "agent", "bot", None, Some(root_id), &[file("three.txt")]);

        let first = s.list_attachments(cid, Some(root_id), None, 2, 0);
        let second = s.list_attachments(cid, Some(root_id), None, 2, 2);
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0]["filename"], "three.txt");
        assert!(first.iter().chain(second.iter()).all(|f| f["thread_name"] == "Renamed thread"));

        let delete_id = root["attachments"][0]["id"].as_str().unwrap();
        let path = s.file_path(delete_id);
        let updated = s.delete_attachment(delete_id).unwrap();
        assert!(!path.exists());
        assert_eq!(updated["id"], root_id);
        assert_eq!(updated["attachments"].as_array().unwrap().len(), 1);
        assert_eq!(s.list_attachments(cid, None, None, 10, 0).len(), 2);

        // Every browser filter uses the `f` alias and must remain executable;
        // unknown kinds intentionally retain the search API's "any" fallback.
        for kind in ["image", "video", "audio", "pdf", "doc", "unknown"] {
            let rows = s.list_attachments(cid, None, Some(kind), 10, 0);
            if kind == "doc" || kind == "unknown" {
                assert!(!rows.is_empty(), "{kind} filter should include text files");
            } else {
                assert!(rows.is_empty(), "{kind} should not match text files");
            }
        }
    }

    #[test]
    fn agents_registry() {
        let s = store();
        s.upsert_agent("mimir", "Mimir", "pantheo-local", false, false, 0);
        s.upsert_agent("mimir", "Mimir 2", "pantheo-local", true, true, 1234);
        let agents = s.known_agents();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["name"], "Mimir 2");
        assert_eq!(agents[0]["requires_mention"], true);
        assert_eq!(agents[0]["has_avatar"], true);
        assert_eq!(agents[0]["avatar_v"], 1234);
        assert!(s.remove_agent("mimir"));
        assert!(s.known_agents().is_empty());
    }

    #[test]
    fn agent_dm_policy_defaults_private_and_conversation_is_unique() {
        let s = Store::open_in_memory().unwrap();
        s.create_user("admin", "Admin", None, "admin");
        s.create_user("alice", "Alice", None, "member");
        s.create_user("bob", "Bob", None, "member");
        s.upsert_agent("codex", "Codex", "test", true, false, 1);
        assert!(!s.user_can_start_agent_dm("alice", "codex"));
        assert!(s.user_can_start_agent_dm("admin", "codex"));
        s.set_agent_dm_policy("codex", false, &["alice".into()]);
        assert!(s.user_can_start_agent_dm("alice", "codex"));
        assert!(!s.user_can_start_agent_dm("bob", "codex"));
        s.set_user_disabled("alice", true);
        assert!(!s.user_can_start_agent_dm("alice", "codex"));
        s.set_user_disabled("alice", false);
        let first = s.open_agent_dm("alice", "codex", "Codex");
        let again = s.open_agent_dm("alice", "codex", "Codex");
        assert_eq!(first["id"], again["id"]);
        assert!(s.user_can_see_channel("alice", first["id"].as_str().unwrap()));
        assert!(!s.user_can_see_channel("bob", first["id"].as_str().unwrap()));
        assert_eq!(s.agents_for_channel(first["id"].as_str().unwrap()), vec!["codex"]);
    }

    #[test]
    fn revoked_agent_dm_is_owner_readable_but_not_routable_or_searchable_by_others() {
        let s = Store::open_in_memory().unwrap();
        s.create_user("alice", "Alice", None, "member");
        s.create_user("bob", "Bob", None, "member");
        s.upsert_agent("codex", "Codex", "test", false, false, 1);
        s.set_agent_dm_policy("codex", true, &[]);
        let dm = s.open_agent_dm("alice", "codex", "Codex");
        let cid = dm["id"].as_str().unwrap();
        s.add_message(cid, "private launch phrase", "agent", "codex", Some("Codex"), None, &[]);
        s.set_agent_dm_policy("codex", false, &[]);
        assert!(s.user_owns_agent_dm("alice", cid));
        assert!(!s.agent_dm_route_allowed(cid, "codex"));
        assert_eq!(s.search_messages("launch", false, None, None, None, None, Some("alice"), false, 20, 0).len(), 1);
        assert!(s.search_messages("launch", false, None, None, None, None, Some("bob"), false, 20, 0).is_empty());
        assert!(s.search_messages("launch", false, None, None, None, None, None, false, 20, 0).is_empty());
    }

    #[test]
    fn users_and_invites_lifecycle() {
        let s = store();
        let u = s.create_user("tom", "Tom", Some(" Tom@Example.COM "), "admin").unwrap();
        assert_eq!(u["username"], "tom");
        assert_eq!(u["email"], "tom@example.com");
        assert_eq!(u["instance_role"], "admin");
        assert_eq!(u["disabled"], false);
        assert_eq!(u["session_version"], 1);
        // Duplicate username refused, existing row untouched.
        assert!(s.create_user("tom", "Imposter", None, "member").is_none());
        assert_eq!(s.user("tom").unwrap()["display_name"], "Tom");
        // Email lookup is case-insensitive.
        assert_eq!(s.user_by_email("TOM@example.com").unwrap()["username"], "tom");
        // unique_username slugs and dedupes.
        assert_eq!(s.unique_username("Tom"), "tom-2");
        assert_eq!(s.unique_username("Alice B"), "alice-b");
        assert_eq!(s.unique_username(""), "user");
        // Disable, role, per-user session revocation.
        assert!(s.set_user_disabled("tom", true));
        assert_eq!(s.user("tom").unwrap()["disabled"], true);
        assert!(s.set_user_disabled("tom", false));
        assert!(s.set_user_instance_role("tom", "member"));
        assert_eq!(s.user("tom").unwrap()["instance_role"], "member");
        assert_eq!(s.bump_session_version("tom"), 2);
        assert_eq!(s.user("tom").unwrap()["session_version"], 2);

        // Invites: shape-checked, case-normalized, consumed on accept.
        assert!(s.create_invite("not-an-email", None, "member").is_none());
        let inv = s.create_invite(" Alice@Example.com ", Some("tom"), "member").unwrap();
        assert_eq!(inv["email"], "alice@example.com");
        assert!(s.pending_invite("ALICE@example.com").is_some());
        s.accept_invite("alice@example.com");
        assert!(s.pending_invite("alice@example.com").is_none());
        assert_eq!(s.list_invites().len(), 1); // kept for provenance
        // Re-inviting a consumed email re-opens it (e.g. after account deletion).
        s.create_invite("alice@example.com", None, "admin").unwrap();
        assert_eq!(s.pending_invite("alice@example.com").unwrap()["instance_role"], "admin");
        assert!(s.delete_invite("alice@example.com"));
        assert!(s.list_invites().is_empty());
    }

    #[test]
    fn delete_user_data_removes_account_row() {
        let s = store();
        s.create_user("tom", "Tom", Some("t@example.com"), "admin");
        s.delete_user_data("tom");
        assert!(s.user("tom").is_none());
        assert!(s.user_by_email("t@example.com").is_none());
    }

    #[test]
    fn user_scoped_search_sees_only_member_groups() {
        let s = store();
        let g1 = s.create_group("Ops", "", Some("tom"));
        let g2 = s.create_group("Secret", "", Some("alice"));
        let c1 = s.create_channel(g1["id"].as_str().unwrap(), "main", "");
        let c2 = s.create_channel(g2["id"].as_str().unwrap(), "main", "");
        s.add_message(c1["id"].as_str().unwrap(), "deploy plan", "user", "tom", None, None, &[]);
        s.add_message(c2["id"].as_str().unwrap(), "deploy secret", "user", "alice", None, None, &[]);
        // Unscoped (privileged) search sees both; tom only his group's hit.
        assert_eq!(s.search_messages("deploy", false, None, None, None, None, None, false, 10, 0).len(), 2);
        let hits = s.search_messages("deploy", false, None, None, None, None, Some("tom"), false, 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["text"], "deploy plan");
        assert!(s.search_messages("deploy", false, None, None, None, None, Some("mallory"), false, 10, 0).is_empty());
    }

    #[test]
    fn push_tokens_upsert_list_delete() {
        let s = store();
        s.upsert_push_token("tom", "ExponentPushToken[a]", "ios");
        s.upsert_push_token("ana", "ExponentPushToken[b]", "android");
        s.upsert_push_token("tom", "ExponentPushToken[a]", "ios"); // refresh
        let mut tokens = s.list_push_tokens();
        tokens.sort();
        assert_eq!(
            tokens,
            vec![
                "ExponentPushToken[a]".to_string(),
                "ExponentPushToken[b]".to_string()
            ]
        );
        assert!(s.delete_push_token("ExponentPushToken[a]"));
        assert_eq!(s.list_push_tokens(), vec!["ExponentPushToken[b]".to_string()]);
        // Deleting an account only drops that account's devices.
        s.upsert_push_token("tom", "ExponentPushToken[c]", "ios");
        s.delete_user_data("tom");
        assert_eq!(s.list_push_tokens(), vec!["ExponentPushToken[b]".to_string()]);
    }

    #[test]
    fn push_fanout_follows_channel_visibility() {
        let s = store();
        s.create_user("tom", "", None, "member").unwrap();
        s.create_user("ana", "", None, "member").unwrap();
        s.create_user("mal", "", None, "member").unwrap();
        s.create_user("op", "", None, "admin").unwrap();
        let g = s.create_group("Team", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        s.add_member(gid, "user", "tom", "admin", None);
        s.add_member(gid, "user", "ana", "member", None);
        let c = s.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap();

        s.upsert_push_token("tom", "ExponentPushToken[tom]", "ios");
        s.upsert_push_token("ana", "ExponentPushToken[ana]", "ios");
        s.upsert_push_token("mal", "ExponentPushToken[mal]", "ios");
        s.upsert_push_token("op", "ExponentPushToken[op]", "ios");

        // Members and instance admins receive; outsiders don't; the author's
        // own devices are excluded.
        let mut got = s.push_tokens_for_channel(cid, Some("tom"));
        got.sort();
        assert_eq!(got, vec!["ExponentPushToken[ana]", "ExponentPushToken[op]"]);

        // Disabled accounts drop out even while they hold a membership.
        s.set_user_disabled("ana", true);
        let got = s.push_tokens_for_channel(cid, Some("tom"));
        assert_eq!(got, vec!["ExponentPushToken[op]"]);

        // Unknown channel: nobody.
        assert!(s.push_tokens_for_channel("nope", None).is_empty());

        // Pre-account rows ('' owner) are silent until the boot migration
        // claims them for the migrated user.
        s.upsert_push_token("", "ExponentPushToken[legacy]", "ios");
        let got = s.push_tokens_for_channel(cid, None);
        assert!(!got.contains(&"ExponentPushToken[legacy]".to_string()));
        s.claim_unowned_push_tokens("tom");
        let got = s.push_tokens_for_channel(cid, None);
        assert!(got.contains(&"ExponentPushToken[legacy]".to_string()));
        assert!(got.contains(&"ExponentPushToken[tom]".to_string()));
    }

    #[test]
    fn user_prefs_are_personal_hidden_and_order() {
        let s = store();
        let g = s.create_group("Team", "", None);
        let gid = g["id"].as_str().unwrap();
        let c1 = s.create_channel(gid, "alpha", "");
        let c2 = s.create_channel(gid, "beta", "");
        let (c1, c2) = (c1["id"].as_str().unwrap(), c2["id"].as_str().unwrap());

        // No prefs yet: empty map.
        assert!(s.user_prefs("tom", "channel").is_empty());

        // Tom hides one channel and orders the pair; Ana sees neither change.
        s.set_pref_hidden("tom", "channel", c1, true);
        s.set_pref_positions("tom", "channel", &[c2.to_string(), c1.to_string()]);
        let tom = s.user_prefs("tom", "channel");
        assert_eq!(tom[c1], (true, Some(2)));
        assert_eq!(tom[c2], (false, Some(1)));
        assert!(s.user_prefs("ana", "channel").is_empty());

        // Un-hiding upserts the same row; ordering survives.
        s.set_pref_hidden("tom", "channel", c1, false);
        assert_eq!(s.user_prefs("tom", "channel")[c1], (false, Some(2)));

        // Group prefs live under their own kind.
        s.set_pref_hidden("tom", "group", gid, true);
        assert_eq!(s.user_prefs("tom", "group")[gid], (true, None));
        assert_eq!(s.user_prefs("tom", "channel").len(), 2);

        // Account deletion sweeps prefs with everything else.
        s.create_user("tom", "", None, "member").unwrap();
        s.delete_user_data("tom");
        assert!(s.user_prefs("tom", "channel").is_empty());
        assert!(s.user_prefs("tom", "group").is_empty());
    }

    #[test]
    fn seed_prefs_copies_legacy_globals_once() {
        let s = store();
        let g = s.create_group("Team", "", None);
        let gid = g["id"].as_str().unwrap();
        let hidden_chan = s.create_channel(gid, "old", "");
        let hid = hidden_chan["id"].as_str().unwrap();
        let plain = s.create_channel(gid, "plain", "");
        let pid = plain["id"].as_str().unwrap();
        // Legacy state: global hidden flag + global manual order.
        s.set_group_hidden(gid, true);
        s.update_channel(hid, None, None, Some(true));
        s.reorder_channels(gid, &[pid.to_string(), hid.to_string()]);

        s.seed_prefs_from_globals("tom");
        let groups = s.user_prefs("tom", "group");
        assert_eq!(groups[gid].0, true);
        let chans = s.user_prefs("tom", "channel");
        assert_eq!(chans[hid], (true, Some(2)));
        assert_eq!(chans[pid], (false, Some(1)));

        // Idempotent: once the user has prefs, later boots leave them alone.
        s.set_pref_hidden("tom", "group", gid, false);
        s.seed_prefs_from_globals("tom");
        assert_eq!(s.user_prefs("tom", "group")[gid].0, false);

        // Other users start clean — the globals were the single admin's view.
        assert!(s.user_prefs("ana", "group").is_empty());
    }

    #[test]
    fn invite_links_are_single_use_and_expire() {
        let s = store();
        let link = s.create_invite_link(Some("tom"), "member", 3600.0);
        let token = link["token"].as_str().unwrap();
        assert_eq!(link["instance_role"], "member");
        assert!(s.valid_invite_link(token).is_some());

        // Consuming marks it used; a second redemption fails.
        assert!(s.use_invite_link(token, "ana"));
        assert!(s.valid_invite_link(token).is_none());
        assert!(!s.use_invite_link(token, "mal"));
        assert_eq!(s.invite_link(token).unwrap()["used_by"], "ana");

        // Expired links don't validate or consume.
        let stale = s.create_invite_link(None, "admin", -1.0);
        let stale_token = stale["token"].as_str().unwrap();
        assert!(s.valid_invite_link(stale_token).is_none());
        assert!(!s.use_invite_link(stale_token, "ana"));

        // Revocation removes the row; listing shows the rest.
        assert!(s.delete_invite_link(stale_token));
        assert!(s.invite_link(stale_token).is_none());
        assert_eq!(s.list_invite_links().len(), 1);
    }

    #[test]
    fn update_message_meta_merges_atomically_across_writers() {
        use std::sync::Arc;
        let s = Arc::new(store());
        let g = s.create_group("G", "", None);
        let c = s.create_channel(g["id"].as_str().unwrap(), "main", "");
        let cid = c["id"].as_str().unwrap();
        let m = s.add_message(cid, "hi", "user", "tom", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();

        // Two writers patching the same message — the unfurl worker vs. an
        // option resolve. Every write adds a key nobody rewrites, so a merge
        // computed from a stale read (the write clobbering the other side's
        // just-added key) stays visible at the end no matter when it happens.
        const ROUNDS: i64 = 200;
        let patch_key = move |s: &Store, prefix: &str, i: i64| {
            let mut patch = serde_json::Map::new();
            patch.insert(format!("{prefix}{i}"), json!(i));
            s.update_message_meta(mid, &Value::Object(patch));
        };
        let (a, b) = (Arc::clone(&s), Arc::clone(&s));
        let ta = std::thread::spawn(move || (0..ROUNDS).for_each(|i| patch_key(&a, "a", i)));
        let tb = std::thread::spawn(move || (0..ROUNDS).for_each(|i| patch_key(&b, "b", i)));
        ta.join().unwrap();
        tb.join().unwrap();
        let meta = &s.message(mid).unwrap()["meta"];
        for i in 0..ROUNDS {
            assert_eq!(meta[format!("a{i}")], i, "lost a{i}");
            assert_eq!(meta[format!("b{i}")], i, "lost b{i}");
        }
    }

    #[test]
    fn unfurl_cache_round_trips_and_expires() {
        let s = store();
        assert!(s.unfurl_cache_get("https://a.com").is_none());
        s.unfurl_cache_put("https://a.com", true, &json!({"title": "A"}));
        let (ok, meta) = s.unfurl_cache_get("https://a.com").unwrap();
        assert!(ok);
        assert_eq!(meta["title"], "A");

        // Failures are cached too, under the shorter TTL.
        s.unfurl_cache_put("https://dead.com", false, &json!({}));
        assert_eq!(s.unfurl_cache_get("https://dead.com").unwrap().0, false);
        s.unfurl_cache_put_at("https://dead.com", false, &json!({}), now() - UNFURL_TTL_ERR - 1.0);
        assert!(s.unfurl_cache_get("https://dead.com").is_none());

        // A success older than its (longer) TTL expires as well.
        s.unfurl_cache_put_at("https://a.com", true, &json!({"title": "A"}), now() - UNFURL_TTL_OK - 1.0);
        assert!(s.unfurl_cache_get("https://a.com").is_none());

        // Re-putting overwrites the stale row.
        s.unfurl_cache_put("https://a.com", true, &json!({"title": "A2"}));
        assert_eq!(s.unfurl_cache_get("https://a.com").unwrap().1["title"], "A2");
    }
}
