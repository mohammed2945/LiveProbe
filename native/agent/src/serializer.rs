use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum SanitizedNode {
    Str { v: String },
    Num { v: f64 },
    Bool { v: bool },
    Null { v: () },
    Obj { c: BTreeMap<String, SanitizedNode> },
    Redacted,
    Truncated { v: String },
    Unavailable { v: UnavailableValue },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableValue {
    pub reason_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SerializerConfig {
    pub max_depth: usize,
    pub max_properties: usize,
    pub max_string: usize,
    pub max_bytes: usize,
    pub redact_keys: Vec<String>,
    pub redact_values: HashSet<String>,
}

impl Default for SerializerConfig {
    fn default() -> Self {
        Self {
            max_depth: 3,
            max_properties: 50,
            max_string: 1024,
            max_bytes: 64 * 1024,
            redact_keys: vec![
                "password",
                "secret",
                "token",
                "authorization",
                "cookie",
                "key",
                "signature",
                "ssn",
                "creditcard",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            redact_values: HashSet::new(),
        }
    }
}

pub fn sanitize_roots(
    values: impl IntoIterator<Item = (String, SanitizedNode)>,
    config: &SerializerConfig,
) -> SanitizedNode {
    SanitizedNode::Obj {
        c: sanitize_values(values, config),
    }
}

pub fn sanitize_values(
    values: impl IntoIterator<Item = (String, SanitizedNode)>,
    config: &SerializerConfig,
) -> BTreeMap<String, SanitizedNode> {
    let mut children = BTreeMap::new();
    let mut properties = 0usize;
    for (key, value) in values {
        if properties >= config.max_properties {
            break;
        }
        properties += 1;
        children.insert(
            key.clone(),
            sanitize_node(&key, value, config, 0, &mut properties),
        );
    }
    if serde_json::to_vec(&children)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
        > config.max_bytes
    {
        children.clear();
        children.insert(
            "$truncated".into(),
            SanitizedNode::Truncated { v: "props".into() },
        );
    }
    children
}

fn sanitize_node(
    key: &str,
    value: SanitizedNode,
    config: &SerializerConfig,
    depth: usize,
    properties: &mut usize,
) -> SanitizedNode {
    if key_is_redacted(key, config) {
        return SanitizedNode::Redacted;
    }
    let exact_value = match &value {
        SanitizedNode::Str { v } => Some(v.clone()),
        SanitizedNode::Num { v } => Some(v.to_string()),
        SanitizedNode::Bool { v } => Some(v.to_string()),
        _ => None,
    };
    if exact_value
        .as_ref()
        .is_some_and(|value| config.redact_values.contains(value))
    {
        return SanitizedNode::Redacted;
    }
    match value {
        SanitizedNode::Str { mut v } => {
            if v.len() > config.max_string {
                v.truncate(config.max_string);
            }
            SanitizedNode::Str { v }
        }
        SanitizedNode::Obj { .. } if depth >= config.max_depth => {
            SanitizedNode::Truncated { v: "depth".into() }
        }
        SanitizedNode::Obj { c } => {
            let mut sanitized = BTreeMap::new();
            for (child_key, child_value) in c {
                if *properties >= config.max_properties {
                    break;
                }
                *properties += 1;
                sanitized.insert(
                    child_key.clone(),
                    sanitize_node(&child_key, child_value, config, depth + 1, properties),
                );
            }
            SanitizedNode::Obj { c: sanitized }
        }
        SanitizedNode::Unavailable { mut v } => {
            // Unavailable diagnostics are outbound evidence. Keep their
            // structured reason and identity, but never forward a resolver
            // detail that could contain a watched path or local value.
            v.detail = None;
            SanitizedNode::Unavailable { v }
        }
        other => other,
    }
}

fn key_is_redacted(key: &str, config: &SerializerConfig) -> bool {
    let lower = key.to_ascii_lowercase();
    config
        .redact_keys
        .iter()
        .any(|pattern| lower.contains(&pattern.to_ascii_lowercase()))
}

pub fn sanitize_diagnostic_detail(
    detail: Option<String>,
    config: &SerializerConfig,
) -> Option<String> {
    detail.map(|mut value| {
        let lower = value.to_ascii_lowercase();
        if config
            .redact_keys
            .iter()
            .any(|pattern| lower.contains(&pattern.to_ascii_lowercase()))
            || config
                .redact_values
                .iter()
                .any(|secret| !secret.is_empty() && value.contains(secret))
        {
            return "[redacted]".into();
        }
        if value.len() > config.max_string {
            value.truncate(config.max_string);
        }
        value
    })
}

pub fn condition_matches(actual: &SanitizedNode, op: &str, expected: &serde_json::Value) -> bool {
    let value = match actual {
        SanitizedNode::Str { v } => serde_json::Value::String(v.clone()),
        SanitizedNode::Num { v } => serde_json::json!(v),
        SanitizedNode::Bool { v } => serde_json::json!(v),
        SanitizedNode::Null { .. } => serde_json::Value::Null,
        _ => return false,
    };
    match op {
        "eq" | "ne" => {
            let equal = match (value.as_f64(), expected.as_f64()) {
                (Some(a), Some(b)) => a == b,
                _ => value == *expected,
            };
            if op == "eq" { equal } else { !equal }
        }
        "gt" | "gte" | "lt" | "lte" => {
            let (Some(a), Some(b)) = (value.as_f64(), expected.as_f64()) else {
                return false;
            };
            match op {
                "gt" => a > b,
                "gte" => a >= b,
                "lt" => a < b,
                _ => a <= b,
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_and_enforces_budget() {
        let mut config = SerializerConfig::default();
        config.redact_values.insert("exact".into());
        let result = sanitize_roots(
            [
                ("apiToken".into(), SanitizedNode::Str { v: "x".into() }),
                ("safe".into(), SanitizedNode::Str { v: "exact".into() }),
            ],
            &config,
        );
        let SanitizedNode::Obj { c } = result else {
            panic!()
        };
        assert_eq!(c["apiToken"], SanitizedNode::Redacted);
        assert_eq!(c["safe"], SanitizedNode::Redacted);
    }
    #[test]
    fn redacts_nested_nodes_and_diagnostic_payloads() {
        let mut config = SerializerConfig::default();
        config.redact_values.insert("raw-secret-value".into());
        let nested = SanitizedNode::Obj {
            c: BTreeMap::from([
                (
                    "password".into(),
                    SanitizedNode::Str {
                        v: "password-value".into(),
                    },
                ),
                (
                    "profile".into(),
                    SanitizedNode::Obj {
                        c: BTreeMap::from([(
                            "apiToken".into(),
                            SanitizedNode::Str {
                                v: "token-value".into(),
                            },
                        )]),
                    },
                ),
                (
                    "label".into(),
                    SanitizedNode::Str {
                        v: "raw-secret-value".into(),
                    },
                ),
            ]),
        };
        let encoded =
            serde_json::to_string(&sanitize_roots([("user".into(), nested)], &config)).unwrap();
        for secret in ["password-value", "token-value", "raw-secret-value"] {
            assert!(!encoded.contains(secret));
        }
        assert_eq!(
            sanitize_diagnostic_detail(Some("token raw-secret-value".into()), &config),
            Some("[redacted]".into())
        );
    }
    #[test]
    fn conditions_have_strict_parity() {
        assert!(condition_matches(
            &SanitizedNode::Num { v: 4.0 },
            "gte",
            &serde_json::json!(4)
        ));
        assert!(condition_matches(
            &SanitizedNode::Num { v: 4242.0 },
            "eq",
            &serde_json::json!(4242)
        ));
        assert!(!condition_matches(
            &SanitizedNode::Str { v: "4".into() },
            "eq",
            &serde_json::json!(4)
        ));
    }

    #[test]
    fn unavailable_values_omit_absent_optional_fields() {
        let encoded = serde_json::to_value(SanitizedNode::Unavailable {
            v: UnavailableValue {
                reason_code: "optimized-out".into(),
                detail: None,
                site_id: None,
                build_id: None,
            },
        })
        .unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({
                "t": "unavailable",
                "v": {"reasonCode": "optimized-out"}
            })
        );
    }
}
