use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub agent_id: String,
    pub broker_url: String,
    pub loader_socket: String,
    pub services: Vec<ServiceConfig>,
    #[serde(default)]
    pub symbol_directories: Vec<String>,
    #[serde(default)]
    pub redact_keys: Vec<String>,
    #[serde(default)]
    pub redact_values: Vec<String>,
    pub debuginfod_url: Option<String>,
    pub symbol_cache_directory: Option<String>,
    #[serde(default = "SafetyConfig::default")]
    pub safety: SafetyConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceConfig {
    pub service_id: String,
    pub language: NativeLanguage,
    pub executable_path: Option<String>,
    pub cgroup_prefix: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NativeLanguage {
    Rust,
    Cpp,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafetyConfig {
    pub preflight_seconds: u64,
    pub max_attachments: usize,
    pub max_raw_hits_per_second: u64,
    pub per_probe_raw_hits_per_second: u64,
    pub max_event_bytes: usize,
    pub max_serializer_millis_per_second: u64,
    pub max_outbound_bytes_per_second: u64,
    #[serde(default = "default_poll_interval_millis")]
    pub poll_interval_millis: u64,
}

fn default_poll_interval_millis() -> u64 {
    1_000
}

impl Default for SafetyConfig {
    fn default() -> Self {
        Self {
            preflight_seconds: 2,
            max_attachments: 256,
            max_raw_hits_per_second: 10_000,
            per_probe_raw_hits_per_second: 2_000,
            max_event_bytes: 64 * 1024,
            max_serializer_millis_per_second: 100,
            max_outbound_bytes_per_second: 1024 * 1024,
            poll_interval_millis: default_poll_interval_millis(),
        }
    }
}

impl AgentConfig {
    pub fn from_path(path: &Path) -> anyhow::Result<Self> {
        let config: Self = serde_json::from_slice(&fs::read(path)?)?;
        anyhow::ensure!(
            config.broker_url.starts_with("http://") || config.broker_url.starts_with("https://"),
            "brokerUrl must be HTTP(S)"
        );
        anyhow::ensure!(
            !config.services.is_empty(),
            "at least one explicit service selector is required"
        );
        for service in &config.services {
            anyhow::ensure!(
                service.executable_path.is_some() || service.cgroup_prefix.is_some(),
                "service {} has no selector",
                service.service_id
            );
        }
        if let Some(url) = &config.debuginfod_url {
            anyhow::ensure!(
                url.starts_with("https://") || url.starts_with("http://"),
                "debuginfodUrl must be HTTP(S)"
            );
            anyhow::ensure!(
                config.symbol_cache_directory.is_some(),
                "symbolCacheDirectory is required with debuginfodUrl"
            );
        }
        anyhow::ensure!(
            (10..=60_000).contains(&config.safety.poll_interval_millis),
            "safety.pollIntervalMillis must be between 10 and 60000"
        );
        Ok(config)
    }
}
