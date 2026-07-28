use crate::config::SafetyConfig;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawHitSample {
    pub generation: u32,
    pub count: u64,
    pub sampled_at_millis: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RawHitRate {
    pub hits: u64,
    pub elapsed_millis: u64,
    pub per_second: f64,
}

pub fn sample_raw_hit_rate(
    previous: &mut Option<RawHitSample>,
    generation: u32,
    count: u64,
    sampled_at_millis: u64,
) -> Option<RawHitRate> {
    let current = RawHitSample {
        generation,
        count,
        sampled_at_millis,
    };
    let Some(prior) = previous.replace(current) else {
        return None;
    };
    if prior.generation != generation
        || count < prior.count
        || sampled_at_millis <= prior.sampled_at_millis
    {
        return None;
    }
    let hits = count - prior.count;
    let elapsed_millis = sampled_at_millis - prior.sampled_at_millis;
    Some(RawHitRate {
        hits,
        elapsed_millis,
        per_second: hits as f64 * 1_000.0 / elapsed_millis as f64,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreflightDecision {
    Approve,
    Sample { every: u64 },
    Reject,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupervisorAction {
    Keep,
    DetachRawHitBudget,
    DetachTtl,
    DetachHitLimit,
}

pub fn decide_preflight(
    raw_hits: u64,
    elapsed_millis: u64,
    limit_per_second: u64,
) -> PreflightDecision {
    let rate = raw_hits.saturating_mul(1000) / elapsed_millis.max(1);
    if rate > limit_per_second.saturating_mul(4) {
        PreflightDecision::Reject
    } else if rate > limit_per_second {
        PreflightDecision::Sample {
            every: rate.div_ceil(limit_per_second.max(1)),
        }
    } else {
        PreflightDecision::Approve
    }
}

#[derive(Default)]
pub struct SafetySupervisor {
    raw_hits: HashMap<u64, u64>,
    host_hits: u64,
}
impl SafetySupervisor {
    pub fn observe(&mut self, cookie: u64, hits: u64) {
        *self.raw_hits.entry(cookie).or_default() += hits;
        self.host_hits += hits;
    }
    pub fn evaluate(
        &self,
        cookie: u64,
        elapsed_seconds: u64,
        captures: u64,
        hit_limit: u64,
        expires_at_ms: u64,
        now_ms: u64,
        config: &SafetyConfig,
    ) -> SupervisorAction {
        if now_ms >= expires_at_ms {
            return SupervisorAction::DetachTtl;
        }
        if captures >= hit_limit {
            return SupervisorAction::DetachHitLimit;
        }
        let seconds = elapsed_seconds.max(1);
        if self.raw_hits.get(&cookie).copied().unwrap_or(0) / seconds
            > config.per_probe_raw_hits_per_second
            || self.host_hits / seconds > config.max_raw_hits_per_second
        {
            return SupervisorAction::DetachRawHitBudget;
        }
        SupervisorAction::Keep
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hot_probe_is_rejected_or_sampled() {
        assert_eq!(
            decide_preflight(100_000, 1_000, 1_000),
            PreflightDecision::Reject
        );
        assert_eq!(
            decide_preflight(2_000, 1_000, 1_000),
            PreflightDecision::Sample { every: 2 }
        );
    }

    #[test]
    fn interval_sampling_detects_a_hot_burst_after_a_long_cold_period() {
        let mut sample = None;
        assert_eq!(sample_raw_hit_rate(&mut sample, 1, 0, 0), None);
        assert_eq!(
            sample_raw_hit_rate(&mut sample, 1, 10, 3_600_000)
                .unwrap()
                .per_second,
            10.0 / 3_600.0
        );
        let burst = sample_raw_hit_rate(&mut sample, 1, 5_010, 3_605_000).unwrap();
        assert_eq!(burst.hits, 5_000);
        assert_eq!(burst.per_second, 1_000.0);
    }

    #[test]
    fn interval_sampling_rebaselines_resets_and_generation_changes() {
        let mut sample = Some(RawHitSample {
            generation: 1,
            count: 100,
            sampled_at_millis: 1_000,
        });
        assert_eq!(sample_raw_hit_rate(&mut sample, 1, 2, 2_000), None);
        assert_eq!(sample_raw_hit_rate(&mut sample, 2, 50, 3_000), None);
        assert_eq!(
            sample_raw_hit_rate(&mut sample, 2, 60, 5_500)
                .unwrap()
                .per_second,
            4.0
        );
    }

    #[test]
    fn interval_sampling_honors_irregular_intervals_and_threshold_boundary() {
        let mut sample = None;
        sample_raw_hit_rate(&mut sample, 9, 4, 100);
        let boundary = sample_raw_hit_rate(&mut sample, 9, 104, 1_100).unwrap();
        assert_eq!(boundary.per_second, 100.0);
        assert!(!(boundary.per_second > 100.0));
        let above = sample_raw_hit_rate(&mut sample, 9, 155, 1_600).unwrap();
        assert_eq!(above.per_second, 102.0);
        assert!(above.per_second > 100.0);
    }
}
