use std::collections::VecDeque;

#[derive(Clone, Debug)]
pub struct JitteredBackoff {
    minimum_millis: u64,
    maximum_millis: u64,
    attempt: u32,
}

impl JitteredBackoff {
    pub fn new(minimum_millis: u64, maximum_millis: u64) -> Self {
        assert!(minimum_millis > 0 && maximum_millis >= minimum_millis);
        Self {
            minimum_millis,
            maximum_millis,
            attempt: 0,
        }
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn next_delay_millis(&mut self, seed: u64) -> u64 {
        let exponent = self.attempt.min(20);
        let ceiling = self
            .minimum_millis
            .saturating_mul(1u64 << exponent)
            .min(self.maximum_millis);
        self.attempt = self.attempt.saturating_add(1);
        // Deterministic xorshift jitter in [50%, 150%], convenient for fake-clock tests.
        let mut value = seed ^ u64::from(self.attempt).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        let half = ceiling / 2;
        half.saturating_add(value % ceiling.max(1))
            .min(self.maximum_millis)
    }
}

#[derive(Debug)]
pub struct BoundedQueue<T> {
    values: VecDeque<(T, usize)>,
    bytes: usize,
    maximum_items: usize,
    maximum_bytes: usize,
    dropped: u64,
}

impl<T> BoundedQueue<T> {
    pub fn new(maximum_items: usize, maximum_bytes: usize) -> Self {
        assert!(maximum_items > 0 && maximum_bytes > 0);
        Self {
            values: VecDeque::new(),
            bytes: 0,
            maximum_items,
            maximum_bytes,
            dropped: 0,
        }
    }

    pub fn push_back(&mut self, value: T, bytes: usize) {
        if bytes > self.maximum_bytes {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        while self.values.len() >= self.maximum_items
            || self.bytes.saturating_add(bytes) > self.maximum_bytes
        {
            if let Some((_, removed)) = self.values.pop_front() {
                self.bytes = self.bytes.saturating_sub(removed);
                self.dropped = self.dropped.saturating_add(1);
            } else {
                break;
            }
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.values.push_back((value, bytes));
    }

    pub fn push_front(&mut self, value: T, bytes: usize) {
        self.push_back(value, bytes);
        if let Some(last) = self.values.pop_back() {
            self.values.push_front(last);
        }
    }

    pub fn pop_front(&mut self) -> Option<(T, usize)> {
        let (value, bytes) = self.values.pop_front()?;
        self.bytes = self.bytes.saturating_sub(bytes);
        Some((value, bytes))
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }
    pub fn bytes(&self) -> usize {
        self.bytes
    }
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_clock_backoff_is_bounded_jittered_and_resettable() {
        let mut backoff = JitteredBackoff::new(100, 2_000);
        let mut fake_clock = 0;
        let delays = (0..20)
            .map(|attempt| {
                let delay = backoff.next_delay_millis(attempt);
                fake_clock += delay;
                delay
            })
            .collect::<Vec<_>>();
        assert!(delays.iter().all(|delay| *delay >= 50 && *delay <= 2_000));
        assert!(fake_clock > 0);
        assert!(delays.windows(2).any(|window| window[0] != window[1]));
        backoff.reset();
        assert!(backoff.next_delay_millis(1) <= 150);
    }

    #[test]
    fn queue_drops_oldest_with_bounded_memory() {
        let mut queue = BoundedQueue::new(2, 10);
        queue.push_back("old", 4);
        queue.push_back("middle", 4);
        queue.push_back("new", 4);
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.bytes(), 8);
        assert_eq!(queue.dropped(), 1);
        assert_eq!(queue.pop_front().map(|entry| entry.0), Some("middle"));
        assert_eq!(queue.pop_front().map(|entry| entry.0), Some("new"));
    }
}
