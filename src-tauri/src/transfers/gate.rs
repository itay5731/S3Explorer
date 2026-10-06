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
//! ticket (FIFO, matching queue order). Every state change (`set_limit`, a slot released, a
//! waiter leaving or starting) calls `notify_waiters`, and each waiter registers its `Notified`
//! future *before* re-checking the condition, so a wake-up can never be missed. Hence:
//! - raising the limit wakes everybody; the oldest waiters start until `running == limit`;
//! - lowering it never touches running transfers; new starts wait until `running < limit`;
//! - permits are RAII guards, so a slot can't leak (a panic or a cancelled waiter cleans up in Drop);
//! - the place in line is taken by `enqueue`, synchronously, so work started in order queues in
//!   that order even when the waiting tasks are first polled in another order;
//! - no deadlock: the mutex is never held across an `.await`.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

struct State {
    running: usize,
    limit: usize,
    next_ticket: u64,
    waiting: BTreeSet<u64>,
}

pub struct RunGate {
    state: Mutex<State>,
    notify: Notify,
}

/// Held while a transfer runs; releases the slot on drop.
pub struct RunPermit {
    gate: Arc<RunGate>,
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        self.gate.lock().running -= 1;
        self.gate.notify.notify_waiters();
    }
}

/// A place in line, taken by [`RunGate::enqueue`]. Dropping it (or the [`Waiter::wait`] future)
/// before it got a slot gives up the place.
pub struct Waiter {
    gate: Arc<RunGate>,
    id: u64,
    pending: bool,
}

impl Drop for Waiter {
    fn drop(&mut self) {
        if self.pending {
            self.gate.lock().waiting.remove(&self.id);
            // It may have been the oldest waiter: let the next one re-check.
            self.gate.notify.notify_waiters();
        }
    }
}

impl RunGate {
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State { running: 0, limit: limit.max(1), next_ticket: 0, waiting: BTreeSet::new() }),
            notify: Notify::new(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Changes the limit immediately (see module docs). Values below 1 are treated as 1.
    pub fn set_limit(&self, limit: usize) {
        self.lock().limit = limit.max(1);
        self.notify.notify_waiters();
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
        let id = {
            let mut s = self.lock();
            let id = s.next_ticket;
            s.next_ticket += 1;
            s.waiting.insert(id);
            id
        };
        Waiter { gate: self.clone(), id, pending: true }
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
        loop {
            let notified = gate.notify.notified();
            tokio::pin!(notified);
            // Register before checking so a notify between the check and the await isn't lost.
            notified.as_mut().enable();
            {
                let mut s = gate.lock();
                if s.running < s.limit && s.waiting.first() == Some(&self.id) {
                    s.waiting.remove(&self.id);
                    s.running += 1;
                    self.pending = false;
                    drop(s);
                    // The next waiter is now the oldest; it may fit too.
                    gate.notify.notify_waiters();
                    return RunPermit { gate: gate.clone() };
                }
            }
            notified.await;
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
