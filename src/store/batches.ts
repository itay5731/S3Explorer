// Folder transfers (batches) live in their own store, like transfers and jobs, so that progress
// events only re-render the batch rows that changed. The per-file transfers of a batch are not kept
// in the transfer list: only the ones currently running are remembered here (to show "now
// transferring" under the batch row), so a 50,000-file batch never becomes 50,000 rows.

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, Batch, BatchPlanRequest, Transfer } from "../lib/types";

export const isBatchActive = (b: Batch) => b.status === "planning" || b.status === "queued" || b.status === "running";

/** Fraction 0..1 of the batch that is finished, by bytes (by files when there are no bytes). */
export function batchFraction(b: Batch): number {
  if (b.status === "completed") return 1;
  if (b.status === "planning" || b.totalFiles === 0) return 0;
  if (b.totalBytes > 0) return Math.min(1, b.doneBytes / b.totalBytes);
  return Math.min(1, (b.doneFiles + b.skippedFiles + b.failedFiles) / b.totalFiles);
}

interface BatchState {
  byId: Record<string, Batch>;
  /** Newest first. Only changes when a batch is added/removed. */
  ids: string[];
  /** Batch rows whose details are expanded in the activity panel. */
  expanded: Record<string, boolean>;
  /** Per batch: its transfers that are queued or running right now (by transfer id). */
  files: Record<string, Record<string, Transfer>>;
  upsertMany(bs: Batch[]): void;
  remove(ids: string[]): void;
  setExpanded(id: string, open: boolean): void;
}

export const useBatches = create<BatchState>((set, get) => ({
  byId: {},
  ids: [],
  expanded: {},
  files: {},
  upsertMany(bs) {
    if (!bs.length) return;
    const { byId, ids } = get();
    const nextById = { ...byId };
    let nextIds = ids;
    for (const b of bs) {
      if (!nextById[b.id]) {
        if (nextIds === ids) nextIds = [...ids];
        nextIds.unshift(b.id);
      }
      nextById[b.id] = b;
    }
    if (nextIds !== ids) nextIds.sort((a, b) => nextById[b].startedAt.localeCompare(nextById[a].startedAt));
    set({ byId: nextById, ids: nextIds });
  },
  remove(removeIds) {
    const drop = new Set(removeIds);
    const byId = { ...get().byId };
    const expanded = { ...get().expanded };
    const files = { ...get().files };
    for (const id of drop) {
      delete byId[id];
      delete expanded[id];
      delete files[id];
    }
    set({ byId, expanded, files, ids: get().ids.filter((id) => !drop.has(id)) });
  },
  setExpanded(id, open) {
    set({ expanded: { ...get().expanded, [id]: open } });
  },
}));

export const selectActiveBatchCount = (s: BatchState) => {
  let n = 0;
  for (const id of s.ids) {
    const b = s.byId[id];
    if (b && isBatchActive(b)) n++;
  }
  return n;
};

/**
 * Fold per-file transfer updates into the batch store (called by the transfer sync for every
 * transfer that carries a `batchId`). Only active files are kept.
 */
export function upsertBatchFiles(ts: Transfer[]) {
  if (!ts.length) return;
  const files = { ...useBatches.getState().files };
  for (const t of ts) {
    const bid = t.batchId!;
    const cur = files[bid] ?? {};
    const active = t.status === "running" || t.status === "queued";
    if (!active && !cur[t.id]) continue;
    const next = { ...cur };
    if (active) next[t.id] = t;
    else delete next[t.id];
    files[bid] = next;
  }
  useBatches.setState({ files });
}

/** The request each batch was started with, by batch id (this session only). */
const requests = new Map<string, BatchPlanRequest>();
export const batchRequest = (id: string) => requests.get(id);

type BatchHandler = (b: Batch, prev: Batch | undefined) => void;
const updateHandlers = new Set<BatchHandler>();

/** Called for every coalesced batch update (at most once per animation frame per batch). */
export function onBatchUpdate(cb: BatchHandler): () => void {
  updateHandlers.add(cb);
  return () => updateHandlers.delete(cb);
}

/** Subscribe to backend batch events, coalescing them per animation frame. */
export async function startBatchSync(): Promise<() => void> {
  let pending = new Map<string, Batch>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const list = [...pending.values()];
    pending = new Map();
    const prev = useBatches.getState().byId;
    useBatches.getState().upsertMany(list);
    for (const b of list) {
      // Finished: nothing of it is running any more.
      if (!isBatchActive(b) && useBatches.getState().files[b.id]) {
        const files = { ...useBatches.getState().files };
        delete files[b.id];
        useBatches.setState({ files });
      }
      updateHandlers.forEach((h) => h(b, prev[b.id]));
    }
  };
  const unlisten = await api.onBatchProgress((b) => {
    pending.set(b.id, b);
    if (!frame) frame = requestAnimationFrame(flush);
  });
  try {
    const list = await api.listBatches();
    const state = useBatches.getState();
    // Keep anything an event already delivered (it is newer than this snapshot).
    state.upsertMany(list.filter((b) => !state.byId[b.id]));
  } catch {
    /* nothing to show */
  }
  return () => {
    unlisten();
    if (frame) cancelAnimationFrame(frame);
  };
}

/** Start a confirmed folder transfer. Resolves with its id; rejects with the backend's `AppError`. */
export async function startBatch(request: BatchPlanRequest): Promise<string> {
  const id = await api.startBatch(request);
  requests.set(id, request);
  return id;
}

export async function cancelBatch(id: string) {
  try {
    await api.cancelBatch(id);
  } catch {
    /* unknown or already finished */
  }
}

/** Forget finished batches. Active ones are skipped (the backend rejects them). */
export async function removeBatches(ids: string[]) {
  const { byId, remove } = useBatches.getState();
  const finished = ids.filter((id) => !byId[id] || !isBatchActive(byId[id]));
  const removed: string[] = [];
  for (const id of finished) {
    try {
      await api.removeBatch(id);
      removed.push(id);
    } catch (e) {
      if ((e as AppError).code === "InvalidInput" && byId[id] && isBatchActive(byId[id])) continue;
      removed.push(id);
    }
  }
  for (const id of removed) requests.delete(id);
  remove(removed);
}
