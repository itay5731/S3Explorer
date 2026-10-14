// Command line (v0.9.0, see "Command line: open the app at a location" in docs/CONTRACT.md):
// `s3explorer [--connection <name>] [<location>]` opens the app at an S3 address or a local path. On
// start (after settings load) the request is taken once; a second launch hands its request to the
// running window through `launch:open`. Without an open connection the named (or most recently used)
// saved connection is connected first; with no saved connection the connect screen says what will
// open, and it opens once the user connects.

import { create } from "zustand";
import * as api from "../lib/api";
import type { AppError, LaunchRequest, SavedConnection } from "../lib/types";
import { activePane, addSharedBucket, getPane, isSplitShown, navigate, setConnected, useApp } from "./app";
import { PANE_IDS, type PaneId } from "./panes";
import { openLocalPath } from "./local";
import { toast } from "./toasts";

/** A request waiting for a connection (shown on the connect screen). */
export const useLaunch = create<{ pending: LaunchRequest | null }>(() => ({ pending: null }));

/** What a request opens, in words: `s3://bucket/prefix` or the local path. */
export function launchLabel(req: LaunchRequest): string {
  if (req.s3) return `s3://${req.s3.bucket}/${req.s3.prefix}`;
  return req.local ?? "";
}

const hasLocation = (req: LaunchRequest) => !!req.s3 || !!req.local;

/** At start: take the command line's request (once) and act on it. Install the second-launch listener. */
export async function startLaunch(): Promise<() => void> {
  let unlisten: api.Unlisten = () => {};
  try {
    unlisten = await api.onLaunchOpen((req) => void handleLaunch(req));
  } catch {
    /* no event bridge */
  }
  try {
    const req = await api.takeLaunchRequest();
    if (req) await handleLaunch(req);
  } catch (e) {
    toast.error("The command line couldn’t be used", (e as AppError).message);
  }
  return unlisten;
}

let applyingSeq = 0;

/** Connect if needed (no prompt), then open the location; or leave it for the connect screen. */
export async function handleLaunch(req: LaunchRequest) {
  if (useApp.getState().connection) {
    if (hasLocation(req)) await applyLaunch(req);
    return;
  }
  let saved: SavedConnection[];
  try {
    saved = await api.listSavedConnections();
  } catch {
    saved = [];
  }
  const want = req.connection?.trim().toLowerCase() ?? null;
  const pick = want
    ? saved.find((c) => c.name.toLowerCase() === want)
    : [...saved].sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))[0];
  if (want && !pick) toast.error(`No saved connection named “${req.connection}”`, "Choose a connection; the location opens once you are connected.");
  if (pick) {
    try {
      const info = await api.connectSaved(pick.id);
      setConnected(info, pick.id);
      if (hasLocation(req)) await applyLaunch(req);
      return;
    } catch (e) {
      toast.error(`Couldn’t connect to “${pick.name}”`, (e as AppError).message);
    }
  }
  // Wait for the user to connect.
  if (hasLocation(req)) useLaunch.setState({ pending: req });
}

// The waiting request is applied once a connection opens (the user connected on the connect screen).
useApp.subscribe((s, prev) => {
  const req = useLaunch.getState().pending;
  if (!req || !s.connection || prev.connection) return;
  useLaunch.setState({ pending: null });
  void applyLaunch(req);
});

/** Wait (bounded) until the bucket lists have loaded, to know whether a bucket is in them. */
async function bucketsLoaded(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const s = useApp.getState();
    if (!s.bucketsLoading && !s.addedLoading) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Open the request's location in the right pane (see "Frontend behaviour" in the contract). */
export async function applyLaunch(req: LaunchRequest) {
  const seq = ++applyingSeq;
  if (req.s3) {
    const { bucket, prefix } = req.s3;
    await bucketsLoaded();
    if (seq !== applyingSeq) return;
    const { buckets, addedBuckets } = useApp.getState();
    if (!buckets.some((b) => b.name === bucket) && !addedBuckets.some((b) => b.name === bucket)) {
      try {
        await addSharedBucket(bucket);
      } catch (e) {
        toast.error(`Couldn’t open s3://${bucket}/`, (e as AppError).message);
        return;
      }
    }
    if (seq !== applyingSeq) return;
    navigate(bucket, prefix, activePane());
    return;
  }
  if (req.local) {
    const pane = localTarget();
    const err = await openLocalPath(pane, req.local);
    if (err) toast.error(`Couldn’t open ${req.local}`, err);
  }
}

/** The pane a local location opens in: the active one in single view; in split the one not showing S3, else the right one. */
function localTarget(): PaneId {
  if (!isSplitShown()) return activePane();
  return PANE_IDS.find((p) => !getPane(p).bucket) ?? "b";
}
