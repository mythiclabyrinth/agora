//! Notification buttons bind to existing interactions; labels are never inferred
//! from styling or an action id. The vocabulary is shared with mobile builds.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Select,
    FormSubmit,
    TableSubmit,
}

impl Kind {
    pub fn resolution_key(&self) -> &'static str {
        match self {
            Self::Select => "resolved",
            Self::FormSubmit => "form_submitted",
            Self::TableSubmit => "table_submitted",
        }
    }
    pub fn interaction_key(&self) -> &'static str {
        match self {
            Self::Select => "options_id",
            Self::FormSubmit => "form_id",
            Self::TableSubmit => "table_id",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub kind: Kind,
    pub id: String,
    pub interaction_id: String,
    pub label: String,
    pub destructive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Actions {
    pub version: u8,
    pub category: String,
    pub actions: Vec<Action>,
}

#[derive(Deserialize)]
struct Category {
    id: String,
    labels: Vec<String>,
}

/// Retain only well-formed author metadata. Invalid metadata disables the
/// shortcut rather than accidentally turning an opt-out back into a default.
pub fn sanitize_notification(value: &Value) -> Value {
    let Some(enabled) = value["enabled"].as_bool() else {
        return json!({"enabled": false});
    };
    let mut result = json!({"enabled": enabled});
    if let Some(label) = value.get("label") {
        let Some(label) = label
            .as_str()
            .filter(|s| !s.is_empty() && s.chars().count() <= 120)
        else {
            return json!({"enabled": false});
        };
        result["label"] = json!(label);
    }
    if let Some(role) = value.get("role") {
        match role.as_str() {
            Some("confirm" | "cancel" | "destructive") => result["role"] = role.clone(),
            _ => return json!({"enabled": false}),
        }
    }
    result
}

pub fn pending(meta: &Value) -> bool {
    (meta["options"]
        .as_array()
        .is_some_and(|options| !options.is_empty())
        && meta["resolved"].is_null())
        || (meta["form"].is_object() && meta["form_submitted"].is_null())
        || (meta["table"].is_object()
            && meta["table_submitted"].is_null()
            && (meta["table"]["buttons"]
                .as_array()
                .is_some_and(|buttons| !buttons.is_empty())
                || meta["table"]["rows"].as_array().is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row["actions"]
                            .as_array()
                            .is_some_and(|actions| !actions.is_empty())
                            && row["id"]
                                .as_str()
                                .is_some_and(|id| meta["table_rows"][id].is_null())
                    })
                })))
}

pub fn for_meta(meta: &Value) -> Option<Actions> {
    let mut actions = Vec::new();
    for (kind, buttons, default_enabled) in [
        (Kind::Select, &meta["options"], true),
        (Kind::FormSubmit, &meta["form"]["buttons"], false),
        (
            Kind::TableSubmit,
            &meta["table"]["buttons"],
            meta["table"]["columns"].as_array().is_some_and(|columns| {
                !columns.is_empty() && columns.iter().all(|c| c["kind"] == "readonly")
            }),
        ),
    ] {
        if !meta[kind.resolution_key()].is_null() {
            continue;
        }
        let Some(buttons) = buttons.as_array() else {
            continue;
        };
        let mut ids = HashSet::new();
        for button in buttons {
            let notification = button.get("notification").map(sanitize_notification);
            let enabled = notification
                .as_ref()
                .and_then(|n| n["enabled"].as_bool())
                .unwrap_or(default_enabled);
            if !enabled {
                continue;
            }
            let id = button["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)?;
            if !ids.insert(id) {
                return None;
            }
            let label = notification
                .as_ref()
                .and_then(|n| n["label"].as_str())
                .or_else(|| button["label"].as_str())?;
            let destructive = notification
                .as_ref()
                .is_some_and(|n| n["role"] == "destructive")
                || button["style"] == "danger";
            let interaction_id = meta[kind.interaction_key()].as_str().unwrap_or_default();
            if interaction_id.len() > 256 {
                return None;
            }
            actions.push(Action {
                kind: kind.clone(),
                id: id.into(),
                label: label.into(),
                destructive,
                interaction_id: interaction_id.into(),
            });
        }
    }
    // Never truncate an approval set: dropping Reject would change its meaning.
    if actions.is_empty() || actions.len() > 4 {
        return None;
    }
    // One notification must not combine unrelated interaction state machines.
    if actions.iter().any(|action| action.kind != actions[0].kind) {
        return None;
    }
    static CATEGORIES: OnceLock<Vec<Category>> = OnceLock::new();
    let categories = CATEGORIES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/core/src/notifications/categories.json"
        ))
        .expect("checked-in notification vocabulary")
    });
    let category = categories.iter().find(|c| {
        c.labels
            .iter()
            .map(String::as_str)
            .eq(actions.iter().map(|a| a.label.as_str()))
    })?;
    let mask = actions
        .iter()
        .enumerate()
        .fold(0, |mask, (i, a)| mask | ((a.destructive as u8) << i));
    Some(Actions {
        version: 1,
        category: format!("agora.v1.{}.d{mask}", category.id),
        actions,
    })
}

/// A separate burst budget keeps two simultaneous approvals visible while
/// bounding alerts from a runaway author. Excess messages remain in-app.
#[derive(Default)]
pub struct AlertBudget {
    start: Option<Instant>,
    count: usize,
}
impl AlertBudget {
    pub fn take(&mut self, now: Instant) -> bool {
        if self
            .start
            .is_none_or(|start| now.duration_since(start) >= Duration::from_secs(10))
        {
            self.start = Some(now);
            self.count = 0;
        }
        self.count = self.count.saturating_add(1);
        self.count <= 6
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_contract_matches_mobile_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../packages/core/testing/notification-actions.json"
        ))
        .unwrap();
        for fixture in fixtures {
            assert_eq!(pending(&fixture["meta"]), fixture["pending"].as_bool().unwrap(), "{}", fixture["name"]);
            let actual = serde_json::to_value(for_meta(&fixture["meta"])).unwrap();
            assert_eq!(actual, fixture["expected"], "{}", fixture["name"]);
        }
    }

    #[test]
    fn options_use_exact_authored_labels_and_order() {
        let meta = json!({"options_id":"p1", "options":[
            {"id":"allow","label":"Approve"},
            {"id":"always","label":"Always allow Bash (this session)",
             "notification":{"enabled":true,"label":"Always allow this tool"}},
            {"id":"deny","label":"Reject","style":"danger"}
        ]});
        let set = for_meta(&meta).unwrap();
        assert_eq!(set.category, "agora.v1.approve-tool-reject.d4");
        assert_eq!(set.actions[1].id, "always");
        assert_eq!(set.actions[1].interaction_id, "p1");
        let mut unknown = meta.clone();
        unknown["options"][0]["label"] = json!("Deploy");
        assert!(for_meta(&unknown).is_none());
        unknown = meta.clone();
        unknown["resolved"] = json!({"option_id":"allow"});
        assert!(for_meta(&unknown).is_none());
    }

    #[test]
    fn editable_state_requires_explicit_opt_in_even_when_populated() {
        let mut meta = json!({"form":{"fields":[{"id":"x","value":"ready"}],
            "buttons":[{"id":"go","label":"Submit"}]},"form_state":{"x":"ready"}});
        assert!(for_meta(&meta).is_none());
        meta["form"]["buttons"][0]["notification"] = json!({"enabled":true});
        assert_eq!(for_meta(&meta).unwrap().actions[0].kind, Kind::FormSubmit);
        meta["form"]["buttons"][0]["notification"] = json!({"enabled":"yes"});
        assert!(for_meta(&meta).is_none());
        let mut table = json!({"table":{"columns":[{"kind":"readonly"}],
            "buttons":[{"id":"go","label":"Approve"}]}});
        assert!(for_meta(&table).is_some());
        table["table"]["columns"][0]["kind"] = json!("text");
        assert!(for_meta(&table).is_none());
        table["table"]["buttons"][0]["notification"] = json!({"enabled":true});
        assert!(for_meta(&table).is_some());
        table["table_submitted"] = json!({"button_id":"go"});
        assert!(for_meta(&table).is_none());
    }

    #[test]
    fn per_row_only_tables_stop_being_pending_when_all_rows_resolve() {
        let mut meta = json!({"table":{"buttons":[],"rows":[{"id":"r1","actions":[{"id":"yes"}]}]}});
        assert!(pending(&meta));
        meta["table_rows"] = json!({"r1":{"action_id":"yes"}});
        assert!(!pending(&meta));
        assert!(for_meta(&meta).is_none());
    }

    #[test]
    fn budget_allows_a_burst_then_recovers() {
        let mut budget = AlertBudget::default();
        let now = Instant::now();
        for _ in 0..6 {
            assert!(budget.take(now));
        }
        assert!(!budget.take(now));
        assert!(budget.take(now + Duration::from_secs(10)));
    }
}
