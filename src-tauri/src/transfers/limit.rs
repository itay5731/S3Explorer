//! Bandwidth limit: one token bucket per direction, shared by every transfer.
//!
//! The bucket is kept as two running totals in bytes: `demand` (every byte ever asked for) and
//! `credit` (every byte the rate has allowed so far). A request for `n` bytes takes the ticket
//! `demand + n` and may go once `credit` reaches it. Credit grows at the rate and is capped at
//! `demand + BURST`, so an idle bucket saves up at most one burst. Tickets are handed out in
//! arrival order, so waiters are served first come, first served: parallel parts and transfers
//! share the limit evenly and none of them can starve behind the others. (f64 counts bytes
//! exactly up to 2^53, about 9 PB per session.)
//!
//! A waiter that goes away before its ticket came up (cancel, pause, an SDK attempt timeout dropping
//! the request body) gives its bytes back: [`Bucket::refund`] adds them to `credit`, which is the same
//! as taking them out of every later ticket, so the ones behind it are not delayed by bytes that
//! were never sent. [`Limiter::take`] and the upload's throttled body both refund on drop.
//!
//! A waiter never sleeps longer than [`RECHECK`] before looking again, so a new rate (or switching
//! the limit off) reaches running transfers within a second. The debt ahead of a ticket is in
//! bytes, so it simply drains at whatever the rate is now.
//!
//! The state ([`Bucket`]) takes the time as an argument, so it is tested on a simulated clock.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::time::Instant;

/// What an idle bucket may save up and then send at full speed.
pub const BURST: u64 = 256 * 1024;
/// Longest single sleep of a waiter, so rate changes apply promptly.
const RECHECK: Duration = Duration::from_millis(250);

/// Token bucket state on an abstract clock (`now` = time since some origin, never decreasing).
#[derive(Debug, Clone)]
pub(crate) struct Bucket {
    /// Bytes per second; `None` = unlimited.
    rate: Option<f64>,
    credit: f64,
    demand: f64,
    last: Duration,
}

impl Bucket {
    pub(crate) fn new(rate: Option<u64>, now: Duration) -> Self {
        Self { rate: rate.map(|r| r as f64), credit: BURST as f64, demand: 0.0, last: now }
    }

    fn refill(&mut self, now: Duration) {
        if let Some(rate) = self.rate {
            let dt = now.saturating_sub(self.last).as_secs_f64();
            self.credit = (self.credit + dt * rate).min(self.demand + BURST as f64);
        }
        self.last = self.last.max(now);
    }

    /// Changes the rate. Credit earned so far counts at the old rate; switching a limit on starts
    /// with a full burst and no debt (nothing was counted while unlimited).
    pub(crate) fn set_rate(&mut self, rate: Option<u64>, now: Duration) {
        self.refill(now);
        if self.rate.is_none() {
            self.credit = self.demand + BURST as f64;
        }
        self.rate = rate.map(|r| r as f64);
    }

    /// Asks for `n` bytes; returns the ticket to wait for, or `None` when unlimited.
    pub(crate) fn reserve(&mut self, n: u64, now: Duration) -> Option<f64> {
        self.rate?;
        self.refill(now);
        self.demand += n as f64;
        Some(self.demand)
    }

    /// Gives back the `n` bytes of `ticket` when its waiter leaves before the ticket came up: every
    /// later ticket moves `n` bytes closer. Credit stays capped at one burst above what was asked
    /// for. A ticket that already came up (its bytes were allowed) is not refunded.
    pub(crate) fn refund(&mut self, ticket: f64, n: u64, now: Duration) {
        if self.rate.is_none() {
            return;
        }
        self.refill(now);
        if self.credit < ticket {
            self.credit = (self.credit + n as f64).min(self.demand + BURST as f64);
        }
    }

    /// How long `ticket` still has to wait at the current rate; `None` once it may go (always
    /// when unlimited).
    pub(crate) fn wait_for(&mut self, ticket: f64, now: Duration) -> Option<Duration> {
        let rate = self.rate?;
        self.refill(now);
        let missing = ticket - self.credit;
        (missing > 0.0).then(|| Duration::from_secs_f64(missing / rate).max(Duration::from_millis(1)))
    }
}

/// A shared, thread-safe bucket on the Tokio clock.
pub struct Limiter {
    bucket: Mutex<Bucket>,
    origin: Instant,
    /// Fast path: unlimited requests never take the lock.
    limited: AtomicBool,
}

impl Limiter {
    /// `kibps`: the limit in KiB/s, `None` = unlimited.
    pub fn new(kibps: Option<u32>) -> Self {
        let rate = kibps.map(|k| u64::from(k) * 1024);
        Self { bucket: Mutex::new(Bucket::new(rate, Duration::ZERO)), origin: Instant::now(), limited: AtomicBool::new(rate.is_some()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Bucket> {
        self.bucket.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn now(&self) -> Duration {
        Instant::now().saturating_duration_since(self.origin)
    }

    /// Applies a new limit (KiB/s, `None` = unlimited) to every waiter within [`RECHECK`].
    pub fn set_kibps(&self, kibps: Option<u32>) {
        let rate = kibps.map(|k| u64::from(k) * 1024);
        let now = self.now();
        self.lock().set_rate(rate, now);
        self.limited.store(rate.is_some(), Ordering::Relaxed);
    }

    /// Takes a ticket for `n` bytes (see [`Self::wait`]); `None` when unlimited.
    pub fn reserve(&self, n: u64) -> Option<f64> {
        if !self.limited.load(Ordering::Relaxed) {
            return None;
        }
        let now = self.now();
        self.lock().reserve(n, now)
    }

    /// The next sleep before `ticket` may go, at most [`RECHECK`]; `None` once it may.
    pub fn delay(&self, ticket: f64) -> Option<Duration> {
        if !self.limited.load(Ordering::Relaxed) {
            return None;
        }
        let now = self.now();
        self.lock().wait_for(ticket, now).map(|d| d.min(RECHECK))
    }

    /// Waits until `ticket` may go.
    pub async fn wait(&self, ticket: f64) {
        while let Some(d) = self.delay(ticket) {
            tokio::time::sleep(d).await;
        }
    }

    /// Whether a limit is set right now.
    pub fn is_limited(&self) -> bool {
        self.limited.load(Ordering::Relaxed)
    }

    /// Gives back a ticket whose waiter left before it came up (see [`Bucket::refund`]).
    pub fn refund(&self, ticket: f64, n: u64) {
        let now = self.now();
        self.lock().refund(ticket, n, now);
    }

    /// Waits until `n` more bytes may pass. Dropped while waiting (cancel, pause), it refunds the
    /// bytes so the waiters behind it are not held back by them.
    pub async fn take(&self, n: u64) {
        if let Some(ticket) = self.reserve(n) {
            let guard = Unredeemed { limiter: self, ticket, n };
            self.wait(ticket).await;
            std::mem::forget(guard);
        }
    }
}

/// Refunds a ticket on drop unless forgotten once the ticket came up.
struct Unredeemed<'a> {
    limiter: &'a Limiter,
    ticket: f64,
    n: u64,
}

impl Drop for Unredeemed<'_> {
    fn drop(&mut self) {
        self.limiter.refund(self.ticket, self.n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KIB: u64 = 1024;

    /// Drives `bucket` like a greedy sender of `chunk`-byte pieces on a simulated clock (sleeping
    /// exactly as told, never longer than `RECHECK`) until `until`; returns the bytes it sent.
    /// `on_tick` may change the bucket at each step.
    fn simulate(bucket: &mut Bucket, start: Duration, until: Duration, chunk: u64, mut on_tick: impl FnMut(&mut Bucket, Duration)) -> u64 {
        let mut now = start;
        let mut sent = 0;
        while now < until {
            match bucket.reserve(chunk, now) {
                None => {
                    sent += chunk;
                    now += Duration::from_micros(1);
                    on_tick(bucket, now);
                    continue;
                }
                Some(ticket) => {
                    while let Some(d) = bucket.wait_for(ticket, now) {
                        now += d.min(RECHECK);
                        on_tick(bucket, now);
                    }
                }
            }
            if now <= until {
                sent += chunk;
            }
        }
        sent
    }

    fn within(got: u64, want: u64, tolerance: f64) -> bool {
        (got as f64 - want as f64).abs() <= want as f64 * tolerance
    }

    #[test]
    fn rate_holds_over_time() {
        for (rate, chunk) in [(64 * KIB, 16 * KIB), (1024 * KIB, 64 * KIB), (100 * 1024 * KIB, 1024 * KIB)] {
            let mut b = Bucket::new(Some(rate), Duration::ZERO);
            let secs = 20;
            let sent = simulate(&mut b, Duration::ZERO, Duration::from_secs(secs), chunk, |_, _| {});
            // Burst once, then the rate: within 2% (plus one chunk of rounding).
            let want = BURST + rate * secs;
            assert!(within(sent, want, 0.02) || sent.abs_diff(want) <= chunk, "rate {rate}: sent {sent}, want ~{want}");
        }
    }

    #[test]
    fn burst_is_capped_after_idling() {
        let mut b = Bucket::new(Some(64 * KIB), Duration::ZERO);
        // An hour of idling saves up one burst, not an hour of credit.
        let t = Duration::from_secs(3600);
        let mut free = 0;
        while b.reserve(16 * KIB, t).is_some_and(|ticket| b.wait_for(ticket, t).is_none()) {
            free += 16 * KIB;
        }
        assert_eq!(free, BURST, "exactly one burst goes without waiting");
        // The next piece waits for its bytes at the rate: 16 KiB at 64 KiB/s = 250 ms.
        let ticket = b.reserve(16 * KIB, t).expect("limited");
        let wait = b.wait_for(ticket, t).expect("must wait");
        assert!((wait.as_secs_f64() - 0.5).abs() < 0.01, "{wait:?}"); // two pieces queued: 32 KiB
    }

    #[test]
    fn a_chunk_larger_than_the_burst_waits_for_its_debt() {
        let mut b = Bucket::new(Some(256 * KIB), Duration::ZERO);
        let ticket = b.reserve(1024 * KIB, Duration::ZERO).expect("limited");
        let wait = b.wait_for(ticket, Duration::ZERO).expect("must wait");
        assert!((wait.as_secs_f64() - 3.0).abs() < 0.01, "(1 MiB - 256 KiB burst) / 256 KiB/s: {wait:?}");
        assert!(b.wait_for(ticket, Duration::from_secs(3)).is_none());
    }

    #[test]
    fn waiters_are_served_in_arrival_order() {
        let mut b = Bucket::new(Some(64 * KIB), Duration::ZERO);
        let t0 = Duration::ZERO;
        let tickets: Vec<f64> = (0..10).map(|_| b.reserve(64 * KIB, t0).expect("limited")).collect();
        let waits: Vec<Duration> = tickets.iter().map(|t| b.wait_for(*t, t0).unwrap_or_default()).collect();
        // The burst (4 x 64 KiB) goes at once; after that each waits one second more than the one before.
        let want: Vec<Duration> = (0..10u64).map(|i| Duration::from_secs(i.saturating_sub(3))).collect();
        let close = waits.iter().zip(&want).all(|(g, w)| g.abs_diff(*w) < Duration::from_millis(5));
        assert!(close, "{waits:?}");
    }

    #[test]
    fn live_rate_change_applies_to_waiters() {
        // 10 s at 64 KiB/s, then raised to 1 MiB/s for 10 s.
        let mut b = Bucket::new(Some(64 * KIB), Duration::ZERO);
        let change = Duration::from_secs(10);
        let mut changed = false;
        let sent = simulate(&mut b, Duration::ZERO, Duration::from_secs(20), 16 * KIB, |b, now| {
            if !changed && now >= change {
                changed = true;
                b.set_rate(Some(1024 * KIB), now);
            }
        });
        let want = BURST + 64 * KIB * 10 + 1024 * KIB * 10;
        assert!(within(sent, want, 0.03), "sent {sent}, want ~{want}");

        // A waiter queued far behind at a low rate is released quickly once the rate goes up.
        let mut b = Bucket::new(Some(64 * KIB), Duration::ZERO);
        let ticket = b.reserve(64 * 64 * KIB, Duration::ZERO).expect("limited"); // ~64 s at 64 KiB/s
        b.set_rate(Some(1_048_576 * KIB), Duration::from_millis(250));
        assert!(b.wait_for(ticket, Duration::from_millis(250) + Duration::from_millis(10)).is_none());

        // Lowered: the remaining debt drains at the new rate.
        let mut b = Bucket::new(Some(1024 * KIB), Duration::ZERO);
        let ticket = b.reserve(BURST + 1024 * KIB, Duration::ZERO).expect("limited"); // 1 s of debt
        b.set_rate(Some(128 * KIB), Duration::from_millis(500)); // half paid
        let wait = b.wait_for(ticket, Duration::from_millis(500)).expect("must wait");
        assert!((wait.as_secs_f64() - 4.0).abs() < 0.01, "512 KiB left at 128 KiB/s: {wait:?}");
    }

    #[test]
    fn unlimited_releases_everyone_and_limiting_again_starts_fresh() {
        let mut b = Bucket::new(Some(64 * KIB), Duration::ZERO);
        let ticket = b.reserve(10 * 1024 * KIB, Duration::ZERO).expect("limited");
        assert!(b.wait_for(ticket, Duration::ZERO).is_some());
        b.set_rate(None, Duration::from_millis(1));
        assert!(b.wait_for(ticket, Duration::from_millis(1)).is_none(), "released at once");
        assert!(b.reserve(u64::MAX / 2, Duration::from_millis(2)).is_none(), "no ticket while unlimited");
        // Limited again: a full burst, no leftover debt.
        b.set_rate(Some(64 * KIB), Duration::from_secs(1));
        let ticket = b.reserve(BURST, Duration::from_secs(1)).expect("limited");
        assert!(b.wait_for(ticket, Duration::from_secs(1)).is_none());
    }

    #[test]
    fn a_dropped_waiter_gives_its_bytes_back() {
        let t0 = Duration::ZERO;
        // Burst used up, then A asks for 1 MiB (16 s at 64 KiB/s) and B for 16 KiB behind it.
        let mut b = Bucket::new(Some(64 * KIB), t0);
        let burst = b.reserve(BURST, t0).expect("limited");
        assert!(b.wait_for(burst, t0).is_none());
        let a = b.reserve(1024 * KIB, t0).expect("limited");
        let b_ticket = b.reserve(16 * KIB, t0).expect("limited");
        assert!(b.wait_for(b_ticket, t0).expect("B waits behind A") > Duration::from_secs(16));
        // A is cancelled one second in: B now waits only for its own 16 KiB, already earned.
        let t1 = Duration::from_secs(1);
        b.refund(a, 1024 * KIB, t1);
        assert!(b.wait_for(b_ticket, t1).is_none(), "no phantom delay for A's unsent bytes");
        // Credit is capped: a request of more than one burst waits for the rate again.
        let c = b.reserve(BURST + 64 * KIB, t1).expect("limited");
        assert!(b.wait_for(c, t1).is_some(), "a refund never grants more than one burst");
    }

    #[test]
    fn a_ticket_that_came_up_is_not_refunded() {
        let t0 = Duration::ZERO;
        let mut b = Bucket::new(Some(64 * KIB), t0);
        let a = b.reserve(BURST, t0).expect("limited");
        assert!(b.wait_for(a, t0).is_none(), "allowed at once");
        b.refund(a, BURST, t0);
        let next = b.reserve(64 * KIB, t0).expect("limited");
        let wait = b.wait_for(next, t0).expect("must wait");
        assert!((wait.as_secs_f64() - 1.0).abs() < 0.01, "{wait:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_take_does_not_delay_the_next_one() {
        let l = std::sync::Arc::new(Limiter::new(Some(64)));
        l.take(BURST).await; // the burst
        let waiter = {
            let l = l.clone();
            tokio::spawn(async move { l.take(64 * 1024 * KIB).await }) // ~17 min at 64 KiB/s
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        waiter.abort();
        let _ = waiter.await;
        // 16 KiB at 64 KiB/s: 250 ms, not 17 minutes behind the aborted request.
        let t = Instant::now();
        tokio::time::timeout(Duration::from_secs(2), l.take(16 * KIB)).await.expect("served without the phantom delay");
        assert!(t.elapsed() < Duration::from_millis(600), "{:?}", t.elapsed());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn limiter_paces_in_real_time_and_follows_changes() {
        let l = std::sync::Arc::new(Limiter::new(Some(1024)));
        let start = Instant::now();
        for _ in 0..(BURST / (16 * KIB) + 64) {
            l.take(16 * KIB).await;
        }
        // Burst, then 64 pieces of 16 KiB at 1 MiB/s = 1 s.
        let took = start.elapsed().as_secs_f64();
        assert!(took > 0.9 && took < 1.5, "{took}");

        // A long wait is cut short by switching the limit off.
        l.set_kibps(Some(64));
        let waiter = {
            let l = l.clone();
            tokio::spawn(async move {
                let t = Instant::now();
                l.take(64 * 1024 * KIB).await; // ~17 min at 64 KiB/s
                t.elapsed()
            })
        };
        tokio::time::sleep(Duration::from_millis(400)).await;
        l.set_kibps(None);
        let waited = waiter.await.expect("join");
        assert!(waited < Duration::from_millis(1000), "{waited:?}");
        // Unlimited: no waiting at all.
        let t = Instant::now();
        l.take(u64::MAX / 4).await;
        assert!(t.elapsed() < Duration::from_millis(50));
    }
}
