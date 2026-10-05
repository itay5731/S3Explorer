// Transfers live in their own store so that 10 Hz progress events only re-render
// the transfer rows that changed — never the object table.

import { create } from "zustand";
import * as api from "../lib/api";
import type { Transfer } from "../lib/types";

interface TransferState {
  byId: Record<string, Transfer>;
  /** Newest first. Only changes when a transfer is added/removed. */
  ids: string[];
  upsertMany(ts: Transfer[]): void;
  replaceAll(ts: Transfer[]): void;
  remove(ids: string[]): void;
}

export const isActive = (t: Transfer) => t.status === "running" || t.status === "queued";

export const useTransfers = create<TransferState>((set, get) => ({
  byId: {},
  ids: [],
  upsertMany(ts) {
    if (!ts.length) return;
    const { byId, ids } = get();
    const nextById = { ...byId };
    let nextIds = ids;
    for (const t of ts) {
      if (!nextById[t.id]) {
        if (nextIds === ids) nextIds = [...ids];
        nextIds.unshift(t.id);
      }
      nextById[t.id] = t;
    }
    set({ byId: nextById, ids: nextIds });
  },
  replaceAll(ts) {
    const sorted = [...ts].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const byId: Record<string, Transfer> = {};
    for (const t of sorted) byId[t.id] = t;
    set({ byId, ids: sorted.map((t) => t.id) });
  },
  remove(removeIds) {
    const drop = new Set(removeIds);
    const byId = { ...get().byId };
    for (const id of drop) delete byId[id];
    set({ byId, ids: get().ids.filter((id) => !drop.has(id)) });
  },
}));

/** Selector: number of queued + running transfers. */
export const selectActiveCount = (s: TransferState) => {
  let n = 0;
  for (const id of s.ids) {
    const t = s.byId[id];
    if (t && isActive(t)) n++;
  }
  return n;
};

type CompletionHandler = (t: Transfer) => void;
const completionHandlers = new Set<CompletionHandler>();

/** Called once per transfer when it first reaches a terminal status via an event. */
export function onTransferFinished(cb: CompletionHandler): () => void {
  completionHandlers.add(cb);
  return () => completionHandlers.delete(cb);
}

/** Subscribe to backend progress events, coalescing them per animation frame. */
export async function startTransferSync(): Promise<() => void> {
  let pending = new Map<string, Transfer>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const batch = [...pending.values()];
    pending = new Map();
    const prev = useTransfers.getState().byId;
    useTransfers.getState().upsertMany(batch);
    for (const t of batch) {
      const before = prev[t.id];
      const terminal = !isActive(t);
      if (terminal && (!before || isActive(before))) completionHandlers.forEach((h) => h(t));
    }
  };
  const unlisten = await api.onTransferProgress((t) => {
    pending.set(t.id, t);
    if (!frame) frame = requestAnimationFrame(flush);
  });
  try {
    useTransfers.getState().replaceAll(await api.listTransfers());
  } catch {
    /* not connected yet / nothing to show */
  }
  return () => {
    unlisten();
    if (frame) cancelAnimationFrame(frame);
  };
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** Re-sync the list from the backend shortly (after starting transfers). */
export function scheduleTransferResync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    try {
      const list = await api.listTransfers();
      const state = useTransfers.getState();
      // Merge rather than replace so newer event data isn't clobbered by an older snapshot.
      state.upsertMany(list.filter((t) => !state.byId[t.id]));
    } catch {
      /* ignore */
    }
  }, 250);
}
