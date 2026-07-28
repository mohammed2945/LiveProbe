use crate::{
    config::NativeLanguage, discovery::DiscoveredInstance, events::NativeEvent,
    resilience::BoundedQueue,
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use std::{fmt, sync::Mutex, time::Duration};

pub struct BrokerClient {
    base_url: String,
    token: Option<String>,
    agent: ureq::Agent,
    pending_ingest: Mutex<BoundedQueue<NativeIngest>>,
}
impl BrokerClient {
    pub fn new(base_url: String, token: Option<String>) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .new_agent();
        Self {
            base_url: base_url.trim_end_matches('/').into(),
            token,
            agent,
            pending_ingest: Mutex::new(BoundedQueue::new(256, 8 * 1024 * 1024)),
        }
    }
    pub fn register(&self, input: &Registration) -> anyhow::Result<RegistrationAcceptance> {
        let mut request = self
            .agent
            .post(format!("{}/v1/native/agents/register", self.base_url));
        if let Some(token) = &self.token {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        Ok(checked(request.send_json(input)?, "native registration")?
            .body_mut()
            .read_json()?)
    }
    pub fn replace_instances(
        &self,
        agent_id: &str,
        instances: &[DiscoveredInstance],
    ) -> anyhow::Result<()> {
        let agent_id = encoded_path_segment(agent_id);
        let mut request = self.agent.put(format!(
            "{}/v1/native/agents/{agent_id}/instances",
            self.base_url
        ));
        if let Some(token) = &self.token {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        checked(
            request.send_json(serde_json::json!({"instances": instances}))?,
            "native instance reconciliation",
        )?;
        Ok(())
    }
    pub fn assignments(&self, agent_id: &str, since: u64) -> anyhow::Result<Assignments> {
        let agent_id = encoded_path_segment(agent_id);
        let mut request = self.agent.get(format!(
            "{}/v1/native/agents/{agent_id}/assignments?since={since}",
            self.base_url
        ));
        if let Some(token) = &self.token {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        Ok(checked(request.call()?, "native assignment polling")?
            .body_mut()
            .read_json()?)
    }
    pub fn ingest(&self, input: &NativeIngest) -> anyhow::Result<()> {
        let mut pending = self
            .pending_ingest
            .lock()
            .map_err(|_| anyhow::anyhow!("broker ingest queue lock poisoned"))?;
        while let Some((batch, bytes)) = pending.pop_front() {
            if let Err(error) = self.send_ingest(&batch) {
                if is_retryable(&error) {
                    pending.push_front(batch, bytes);
                    self.enqueue_ingest(&mut pending, input)?;
                    eprintln!("broker ingest unavailable; queued bounded batch: {error:#}");
                    return Ok(());
                }
                eprintln!("dropping broker-rejected queued ingest batch: {error:#}");
            }
        }
        if let Err(error) = self.send_ingest(input) {
            if is_retryable(&error) {
                self.enqueue_ingest(&mut pending, input)?;
                eprintln!("broker ingest unavailable; queued bounded batch: {error:#}");
            } else {
                eprintln!("dropping broker-rejected ingest batch: {error:#}");
            }
        }
        Ok(())
    }

    pub fn flush_pending_ingest(&self) {
        let Ok(mut pending) = self.pending_ingest.lock() else {
            return;
        };
        while let Some((batch, bytes)) = pending.pop_front() {
            if let Err(error) = self.send_ingest(&batch) {
                if is_retryable(&error) {
                    pending.push_front(batch, bytes);
                    eprintln!("broker ingest still unavailable: {error:#}");
                    break;
                }
                eprintln!("dropping broker-rejected queued ingest batch: {error:#}");
            }
        }
    }

    fn send_ingest(&self, input: &NativeIngest) -> anyhow::Result<()> {
        let mut request = self
            .agent
            .post(format!("{}/v1/native/ingest", self.base_url));
        if let Some(token) = &self.token {
            request = request.header("authorization", &format!("Bearer {token}"));
        }
        checked(request.send_json(input)?, "native event ingestion")?;
        Ok(())
    }

    fn enqueue_ingest(
        &self,
        pending: &mut BoundedQueue<NativeIngest>,
        input: &NativeIngest,
    ) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(input)?.len();
        let dropped_before = pending.dropped();
        pending.push_back(input.clone(), bytes);
        if pending.dropped() != dropped_before {
            eprintln!("broker ingest queue full; dropped oldest batch according to bounded policy");
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn pending_ingest_batches(&self) -> usize {
        self.pending_ingest.lock().map_or(0, |queue| queue.len())
    }
}

fn encoded_path_segment(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn checked(
    mut response: ureq::http::Response<ureq::Body>,
    operation: &str,
) -> anyhow::Result<ureq::http::Response<ureq::Body>> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let detail = response
        .body_mut()
        .with_config()
        .limit(4_096)
        .read_to_string()
        .unwrap_or_else(|error| format!("<unreadable response: {error}>"));
    Err(BrokerHttpError {
        operation: operation.to_owned(),
        status,
        detail,
    }
    .into())
}

#[derive(Debug)]
struct BrokerHttpError {
    operation: String,
    status: u16,
    detail: String,
}

impl fmt::Display for BrokerHttpError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            output,
            "{} failed with HTTP {}: {}",
            self.operation, self.status, self.detail
        )
    }
}

impl std::error::Error for BrokerHttpError {}

pub fn is_retryable(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<BrokerHttpError>()
        .map_or(true, |error| {
            error.status == 408 || error.status == 429 || error.status >= 500
        })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub agent_id: String,
    pub hostname: String,
    pub backend: &'static str,
    pub architecture: String,
    pub capabilities: Vec<String>,
    pub agent_version: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationAcceptance {
    pub agent_id: String,
    pub accepted: bool,
    pub last_seen: String,
    pub allowed_service_ids: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignments {
    pub version: u64,
    pub assignments: Vec<Assignment>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub instance_id: String,
    pub service_id: String,
    pub build_id: String,
    pub probes: Vec<ProbeAssignment>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAssignment {
    pub id: String,
    pub version: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub file: String,
    pub line: u64,
    pub watch_paths: Option<Vec<String>>,
    pub template: Option<String>,
    pub metric_path: Option<String>,
    pub condition: Option<Condition>,
    pub hit_limit: u64,
    pub ttl_seconds: u64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Condition {
    pub path: String,
    pub op: String,
    pub value: serde_json::Value,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIngest {
    pub agent_id: String,
    pub service_id: String,
    pub instance_id: String,
    pub build_id: String,
    pub backend: &'static str,
    pub agent_status: AgentStatus,
    pub events: Vec<NativeEvent>,
}
#[derive(Clone, Serialize)]
pub struct AgentStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub fn language_name(language: NativeLanguage) -> &'static str {
    match language {
        NativeLanguage::Rust => "rust",
        NativeLanguage::Cpp => "cpp",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http_error(status: u16) -> anyhow::Error {
        BrokerHttpError {
            operation: "test".into(),
            status,
            detail: "failure".into(),
        }
        .into()
    }

    #[test]
    fn retries_transport_throttling_timeout_and_server_failures() {
        assert!(is_retryable(&anyhow::anyhow!("connection reset")));
        assert!(is_retryable(&http_error(408)));
        assert!(is_retryable(&http_error(429)));
        assert!(is_retryable(&http_error(500)));
        assert!(is_retryable(&http_error(503)));
    }

    #[test]
    fn does_not_retry_permanent_client_rejections() {
        assert!(!is_retryable(&http_error(400)));
        assert!(!is_retryable(&http_error(401)));
        assert!(!is_retryable(&http_error(403)));
        assert!(!is_retryable(&http_error(404)));
    }

    #[test]
    fn percent_encodes_agent_ids_as_single_path_segments() {
        assert_eq!(encoded_path_segment("host/a?blue#1"), "host%2Fa%3Fblue%231");
    }

    #[test]
    fn consumes_the_shared_typescript_wire_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/native-wire.json"
        ))
        .unwrap();
        let assignments: Assignments =
            serde_json::from_value(fixture["assignments"].clone()).unwrap();
        assert_eq!(assignments.version, 9);
        assert_eq!(assignments.assignments[0].build_id, "abcdef1234567890");
        assert_eq!(assignments.assignments[0].probes[0].version, 3);
    }
}
