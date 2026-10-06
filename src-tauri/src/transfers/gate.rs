//! Resizable FIFO gate limiting how many transfers run at once.
//!
//! Why not `tokio::sync::Semaphore`: growing it is easy (`add_permits`) but shrinking while
//! permits are held needs either `forget_permits` (which can only forget *available* permits, so
//! the remainder must be tracked and forgotten as running transfers release theirs) or a
//! background task that acquires-and-forgets the difference (which then has to be cancelled when
//! the limit is raised again). Both are easy to get subtly wrong when the limit changes several
//! times in a row.
//!
//! Instead the whole state is a counter under one mutex: `running`, `limit` and the set of waiting
//! tickets. A waiter may start only when `running < limit` *and* it holds the oldest waiting
//! ticket (FIFO, matching queue order). Only the oldest waiter can ever start, so every state
//! change (`set_limit`, a slot released, a waiter leaving or starting) wakes just that one through
//! its own `Notify` (`notify_one` stores the wake-up if the waiter is not parked yet, so none is
//! lost). Waking everybody instead made each change cost O(waiting): a 50,000-file folder transfer
//! queues 50,000 waiters and would have done ~10^9 wake-ups over its lifetime. Hence:
//! - raising the limit wakes everybody; the oldest waiters start until `running == limit`;
//! - lowering it never touches running transfers; new starts wait until `running < limit`;
//! - permits are RAII guards, so a slot can't leak (a panic or a cancelled waiter cleans up in Drop);
//! - the place in line is taken by `enqueue`, synchronously, so work started in order queues in
//!   that order even when the waiting tasks are first polled in another order;
//! - no deadlock: the mutex is never held across an `.await`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

struct State {
    running: usize,
    limit: usize,
    next_ticket: u64,
    /// Waiting tickets in line order, each with the `Notify` that wakes its waiter.
    waiting: BTreeMap<u64, Arc<Notify>>,
}

impl State {
    /// Wakes the oldest waiter (the only one that can start) so it re-checks.
    fn wake_head(&self) {
        if let Some((_, n)) = self.waiting.first_key_value() {
            n.notify_one();
        }
    }
}

pub struct RunGate {
    state: Mutex<State>,
}

/// Held while a transfer runs; releases the slot on drop.
pub struct RunPermit {
    gate: Arc<RunGate>,
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        let mut s = self.gate.lock();
        s.running -= 1;
        s.wake_head();
    }
}

/// A place in line, taken by [`RunGate::enqueue`]. Dropping it (or the [`Waiter::wait`] future)
/// before it got a slot gives up the place.
pub struct Waiter {
    gate: Arc<RunGate>,
    id: u64,
    notify: Arc<Notify>,
    pending: bool,
}

impl Drop for Waiter {
    fn drop(&mut self) {
        if self.pending {
            let mut s = self.gate.lock();
            s.waiting.remove(&self.id);
            // It may have been the oldest waiter: let the next one re-check.
            s.wake_head();
        }
    }
}

impl RunGate {
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State { running: 0, limit: limit.max(1), next_ticket: 0, waiting: BTreeMap::new() }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Changes the limit immediately (see module docs). Values below 1 are treated as 1.
    pub fn set_limit(&self, limit: usize) {
        let mut s = self.lock();
        s.limit = limit.max(1);
        s.wake_head();
    }

    pub fn running(&self) -> usize {
        self.lock().running
    }

    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        self.lock().waiting.len()
    }

    /// Takes a place in line now (synchronously): the order of `enqueue` calls is the start
    /// order, however the tasks that later call [`Waiter::wait`] happen to be scheduled.
    pub fn enqueue(self: &Arc<Self>) -> Waiter {
        let notify = Arc::new(Notify::new());
        let id = {
            let mut s = self.lock();
            let id = s.next_ticket;
            s.next_ticket += 1;
            s.waiting.insert(id, notify.clone());
            id
        };
        Waiter { gate: self.clone(), id, notify, pending: true }
    }

    /// `enqueue` then `wait`: the place in line is taken when this future is first polled (tests;
    /// the app enqueues synchronously at start).
    #[cfg(test)]
    pub async fn acquire(self: &Arc<Self>) -> RunPermit {
        self.enqueue().wait().await
    }
}

impl Waiter {
    /// Waits for a run slot (FIFO). Cancel-safe: dropping the future gives up the place in line.
    pub async fn wait(mut self) -> RunPermit {
        let gate = self.gate.clone();
        let notify = self.notify.clone();
        loop {
            {
                let mut s = gate.lock();
                if s.running < s.limit && s.waiting.first_key_value().map(|(id, _)| *id) == Some(self.id) {
                    s.waiting.remove(&self.id);
                    s.running += 1;
                    self.pending = false;
                    // The next waiter is now the oldest; it may fit too.
                    s.wake_head();
                    return RunPermit { gate: gate.clone() };
                }
            }
            // A wake-up sent between the check and this await is stored by `notify_one`.
            notify.notified().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::{mpsc, oneshot};

    /// Lets every ready task on the current-thread runtime run until nothing changes.
    async fn settle() {
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
    }

    /// Spawns a task that takes a slot, reports `n` on `started`, and holds the slot until released.
    fn spawn_holder(gate: &Arc<RunGate>, n: usize, started: &mpsc::UnboundedSender<usize>) -> oneshot::Sender<()> {
        let (tx, rx) = oneshot::channel::<()>();
        let (gate, started) = (gate.clone(), started.clone());
        tokio::spawn(async move {
            let _p = gate.acquire().await;
            let _ = started.send(n);
            let _ = rx.await;
        });
        tx
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<usize>) -> Vec<usize> {
        let mut v = Vec::new();
        while let Ok(n) = rx.try_recv() {
            v.push(n);
        }
        v
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fifo_and_limit() {
        let gate = RunGate::new(2);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut release: Vec<_> = (0..5).map(|n| spawn_holder(&gate, n, &tx)).collect();
        settle().await;
        assert_eq!(drain(&mut rx), vec![0, 1]);
        assert_eq!((gate.running(), gate.waiting()), (2, 3));
        // Finishing one lets exactly the oldest waiter in.
        let _ = release.remove(0).send(());
        settle().await;
        assert_eq!(drain(&mut rx), vec![2]);
        assert_eq!(gate.running(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn raise_starts_queued_immediately() {
        let gate = RunGate::new(1);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _release: Vec<_> = (0..4).map(|n| spawn_holder(&gate, n, &tx)).collect();
        settle().await;
        assert_eq!(drain(&mut rx), vec![0]);
        gate.set_limit(3);
        settle().await;
        // Nobody released anything, yet two queued transfers started.
        assert_eq!(drain(&mut rx), vec![1, 2]);
        assert_eq!((gate.running(), gate.waiting()), (3, 1));
        gate.set_limit(10);
        settle().await;
        assert_eq!(drain(&mut rx), vec![3]);
        assert_eq!((gate.running(), gate.waiting()), (4, 0));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lower_never_interrupts_and_blocks_new_starts() {
        let gate = RunGate::new(3);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut release: Vec<_> = (0..6).map(|n| spawn_holder(&gate, n, &tx)).collect();
        settle().await;
        assert_eq!(drain(&mut rx), vec![0, 1, 2]);
        gate.set_limit(1);
        settle().await;
        assert_eq!(gate.running(), 3, "running transfers keep their slots");
        // Releasing two leaves running = 1 = limit: still no new start.
        let _ = release.remove(0).send(());
        let _ = release.remove(0).send(());
        settle().await;
        assert!(drain(&mut rx).is_empty());
        assert_eq!((gate.running(), gate.waiting()), (1, 3));
        // Below the limit again: exactly one more starts.
        let _ = release.remove(0).send(());
        settle().await;
        assert_eq!(drain(&mut rx), vec![3]);
        assert_eq!(gate.running(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn many_changes_while_busy() {
        let gate = RunGate::new(2);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut release: Vec<_> = (0..8).map(|n| spawn_holder(&gate, n, &tx)).collect();
        settle().await;
        assert_eq!(drain(&mut rx), vec![0, 1]);
        // Down, up, down, up without settling in between: only the final limit matters.
        gate.set_limit(1);
        gate.set_limit(5);
        gate.set_limit(1);
        gate.set_limit(4);
        settle().await;
        assert_eq!(drain(&mut rx), vec![2, 3]);
        assert_eq!(gate.running(), 4);
        gate.set_limit(2);
        for _ in 0..3 {
            let _ = release.remove(0).send(());
        }
        settle().await;
        // 4 - 3 = 1 running < 2: one more starts.
        assert_eq!(drain(&mut rx), vec![4]);
        assert_eq!(gate.running(), 2);
        gate.set_limit(10);
        settle().await;
        assert_eq!(drain(&mut rx), vec![5, 6, 7]);
        assert_eq!((gate.running(), gate.waiting()), (5, 0));
        release.clear(); // dropping the senders ends every holder
        settle().await;
        assert_eq!(gate.running(), 0, "no slot leaked");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_waiter_gives_up_its_place() {
        let gate = RunGate::new(1);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let first = spawn_holder(&gate, 0, &tx);
        settle().await;
        // The oldest waiter gives up (like a cancelled queued transfer).
        let g = gate.clone();
        let waiter = tokio::spawn(async move {
            let _p = g.acquire().await;
        });
        settle().await;
        let _later = spawn_holder(&gate, 2, &tx);
        settle().await;
        assert_eq!(gate.waiting(), 2);
        waiter.abort();
        settle().await;
        assert_eq!(gate.waiting(), 1);
        let _ = first.send(());
        settle().await;
        assert_eq!(drain(&mut rx), vec![0, 2], "the next waiter is not stuck behind the cancelled one");
        assert_eq!(gate.running(), 1);
    }

    /// Places in line are taken by `enqueue`, in call order, not when the waiting task first
    /// runs. (Regression: jobs and transfers took their ticket inside a spawned task, so three
    /// jobs started in order could queue in any order on the multi-thread runtime.)
    #[tokio::test(flavor = "current_thread")]
    async fn order_is_enqueue_order_not_poll_order() {
        let gate = RunGate::new(1);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let first = spawn_holder(&gate, 0, &tx);
        settle().await;
        let waiters: Vec<Waiter> = (1..=3).map(|_| gate.enqueue()).collect();
        // Spawn (and so first poll) them in reverse order; each releases its slot at once.
        for (n, w) in waiters.into_iter().enumerate().rev() {
            let started = tx.clone();
            tokio::spawn(async move {
                let _p = w.wait().await;
                let _ = started.send(n + 1);
            });
        }
        settle().await;
        assert_eq!((gate.running(), gate.waiting()), (1, 3));
        let _ = first.send(());
        settle().await;
        assert_eq!(drain(&mut rx), vec![0, 1, 2, 3]);
        assert_eq!((gate.running(), gate.waiting()), (0, 0));
    }

    /// Many waiters: each release wakes only the next in line, so the whole queue drains in
    /// order and quickly (waking everybody on every change was quadratic).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_long_queue_drains_in_order() {
        let gate = RunGate::new(3);
        let n = 20_000;
        let order = Arc::new(Mutex::new(Vec::with_capacity(n)));
        let waiters: Vec<Waiter> = (0..n).map(|_| gate.enqueue()).collect();
        let mut tasks = Vec::with_capacity(n);
        for (i, w) in waiters.into_iter().enumerate() {
            let order = order.clone();
            tasks.push(tokio::spawn(async move {
                let _p = w.wait().await;
                order.lock().unwrap().push(i);
                tokio::task::yield_now().await;
            }));
        }
        let t0 = std::time::Instant::now();
        for t in tasks {
            t.await.unwrap();
        }
        assert!(t0.elapsed() < std::time::Duration::from_secs(20), "{:?}", t0.elapsed());
        let order = order.lock().unwrap();
        assert_eq!(order.len(), n);
        // FIFO start order; with 3 slots, a start can be at most 2 places ahead of its turn.
        assert!(order.iter().enumerate().all(|(pos, i)| i.abs_diff(pos) <= 2));
        assert_eq!((gate.running(), gate.waiting()), (0, 0));
    }

    /// An enqueued waiter that is dropped without waiting gives up its place.
    #[tokio::test(flavor = "current_thread")]
    async fn dropped_waiter_leaves_the_line() {
        let gate = RunGate::new(1);
        let w = gate.enqueue();
        assert_eq!(gate.waiting(), 1);
        drop(w);
        assert_eq!(gate.waiting(), 0);
        let _p = gate.acquire().await;
        assert_eq!(gate.running(), 1);
    }
}
