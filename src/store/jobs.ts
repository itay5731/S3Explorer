// Jobs (delete / copy / move) live in their own store, like transfers, so that 10 Hz
// progress events only re-render the job rows that changed — never the object table.

import { create } from "zustand";
import * as api from "../lib/api";
import type { Job, JobRequest } from "../lib/types";
import { isJobActive } from "../lib/ops";

interface JobState {
  byId: Record<string, Job>;
  /** Newest first. Only changes when a job is added/removed. */
  ids: string[];
  /** Job rows whose error list is expanded in the activity panel. */
  expanded: Record<string, boolean>;
  upsertMany(js: Job[]): void;
  replaceAll(js: Job[]): void;
  remove(ids: string[]): void;
  setExpanded(id: string, open: boolean): void;
}

export const useJobs = create<JobState>((set, get) => ({
  byId: {},
  ids: [],
  expanded: {},
  upsertMany(js) {
    if (!js.length) return;
    const { byId, ids } = get();
    const nextById = { ...byId };
    let nextIds = ids;
    for (const j of js) {
      if (!nextById[j.id]) {
        if (nextIds === ids) nextIds = [...ids];
        nextIds.unshift(j.id);
      }
      nextById[j.id] = j;
    }
    set({ byId: nextById, ids: nextIds });
  },
  replaceAll(js) {
    const sorted = [...js].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const byId: Record<string, Job> = {};
    for (const j of sorted) byId[j.id] = j;
    set({ byId, ids: sorted.map((j) => j.id) });
  },
  remove(removeIds) {
    const drop = new Set(removeIds);
    const byId = { ...get().byId };
    const expanded = { ...get().expanded };
    for (const id of drop) {
      delete byId[id];
      delete expanded[id];
    }
    set({ byId, expanded, ids: get().ids.filter((id) => !drop.has(id)) });
  },
  setExpanded(id, open) {
    set({ expanded: { ...get().expanded, [id]: open } });
  },
}));

export const selectActiveJobCount = (s: JobState) => {
  let n = 0;
  for (const id of s.ids) {
    const j = s.byId[id];
    if (j && isJobActive(j)) n++;
  }
  return n;
};

/**
 * The request each job was started with, by job id (this session only). Jobs carry no item
 * list, so this is how the UI knows which folders a job touches.
 */
const requests = new Map<string, JobRequest>();
export const rememberJobRequest = (id: string, req: JobRequest) => requests.set(id, req);
export const jobRequest = (id: string) => requests.get(id);

type JobHandler = (job: Job, prev: Job | undefined) => void;
const updateHandlers = new Set<JobHandler>();

/** Called for every coalesced job update (at most once per animation frame per job). */
export function onJobUpdate(cb: JobHandler): () => void {
  updateHandlers.add(cb);
  return () => updateHandlers.delete(cb);
}

/** Subscribe to backend progress events, coalescing them per animation frame. */
export async function startJobSync(): Promise<() => void> {
  let pending = new Map<string, Job>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const batch = [...pending.values()];
    pending = new Map();
    const prev = useJobs.getState().byId;
    useJobs.getState().upsertMany(batch);
    for (const j of batch) updateHandlers.forEach((h) => h(j, prev[j.id]));
  };
  const unlisten = await api.onJobProgress((j) => {
    pending.set(j.id, j);
    if (!frame) frame = requestAnimationFrame(flush);
  });
  try {
    const list = await api.listJobs();
    const state = useJobs.getState();
    // Keep anything an event already delivered (it is newer than this snapshot).
    state.upsertMany(list.filter((j) => !state.byId[j.id]));
  } catch {
    /* nothing to show */
  }
  return () => {
    unlisten();
    if (frame) cancelAnimationFrame(frame);
  };
}

/** Forget finished jobs. Active ones are skipped (the backend rejects them). */
export async function removeJobs(ids: string[]) {
  const { byId, remove } = useJobs.getState();
  const finished = ids.filter((id) => !byId[id] || !isJobActive(byId[id]));
  const removed: string[] = [];
  for (const id of finished) {
    try {
      await api.removeJob(id);
      removed.push(id);
    } catch (e) {
      // Still active on the backend (state raced): keep it. Anything else: drop locally.
      if ((e as { code?: string }).code === "InvalidInput" && byId[id] && isJobActive(byId[id])) continue;
      removed.push(id);
    }
  }
  for (const id of removed) requests.delete(id);
  remove(removed);
}
