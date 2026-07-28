use crate::serializer::SanitizedNode;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NativeEvent {
    Snapshot {
        #[serde(rename = "probeId")]
        probe_id: String,
        #[serde(rename = "probeVersion")]
        probe_version: u64,
        ts: String,
        variables: SanitizedNode,
        watches: BTreeMap<String, SanitizedNode>,
        stack: Vec<StackFrame>,
    },
    Log {
        #[serde(rename = "probeId")]
        probe_id: String,
        #[serde(rename = "probeVersion")]
        probe_version: u64,
        ts: String,
        message: String,
        level: String,
    },
    Counter {
        #[serde(rename = "probeId")]
        probe_id: String,
        #[serde(rename = "probeVersion")]
        probe_version: u64,
        ts: String,
        delta: u64,
    },
    Metric {
        #[serde(rename = "probeId")]
        probe_id: String,
        #[serde(rename = "probeVersion")]
        probe_version: u64,
        ts: String,
        count: u64,
        sum: f64,
        min: f64,
        max: f64,
        last: f64,
    },
    Status {
        #[serde(rename = "probeId")]
        probe_id: String,
        ts: String,
        status: String,
        #[serde(rename = "reasonCode", skip_serializing_if = "Option::is_none")]
        reason_code: Option<String>,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "buildId")]
        build_id: String,
        #[serde(rename = "probeVersion")]
        probe_version: u64,
        #[serde(rename = "siteId", skip_serializing_if = "Option::is_none")]
        site_id: Option<String>,
        #[serde(rename = "physicalSiteCount", skip_serializing_if = "Option::is_none")]
        physical_site_count: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resolution: Option<ResolutionStatus>,
        #[serde(rename = "rawHitRate", skip_serializing_if = "Option::is_none")]
        raw_hit_rate: Option<f64>,
        #[serde(rename = "droppedEventCount", skip_serializing_if = "Option::is_none")]
        dropped_event_count: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionStatus {
    pub source_file: String,
    pub line: u64,
    pub resolved_site_count: u32,
    pub requested_path_count: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct StackFrame {
    pub r#fn: String,
    pub file: String,
    pub line: u32,
}

impl NativeEvent {
    pub fn probe_id(&self) -> &str {
        match self {
            Self::Snapshot { probe_id, .. }
            | Self::Log { probe_id, .. }
            | Self::Counter { probe_id, .. }
            | Self::Metric { probe_id, .. }
            | Self::Status { probe_id, .. } => probe_id,
        }
    }

    pub fn probe_version(&self) -> u64 {
        match self {
            Self::Snapshot { probe_version, .. }
            | Self::Log { probe_version, .. }
            | Self::Counter { probe_version, .. }
            | Self::Metric { probe_version, .. }
            | Self::Status { probe_version, .. } => *probe_version,
        }
    }
}

pub fn render_log(template: &str, values: &BTreeMap<String, SanitizedNode>) -> String {
    let mut output = template.to_owned();
    for (path, value) in values {
        let rendered = match value {
            SanitizedNode::Str { v } => v.clone(),
            SanitizedNode::Num { v } => v.to_string(),
            SanitizedNode::Bool { v } => v.to_string(),
            SanitizedNode::Null { .. } => "null".into(),
            SanitizedNode::Unavailable { .. } => "[unavailable]".into(),
            _ => "[complex]".into(),
        };
        output = output.replace(&format!("${{{path}}}"), &rendered);
    }
    output
}
