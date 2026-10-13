// "Pause all" / "Resume all" (Activity bar and the act.pauseAll / act.resumeAll keys): single
// transfers and folder transfers; a folder transfer's own files follow their batch.

import { isMoving, setTransferPaused, useTransfers } from "./transfers";
import { setBatchPaused, useBatches } from "./batches";

const batchPausable = (status: string | undefined) => status === "queued" || status === "running";

/** Is there anything Pause all would pause? */
export function canPauseAll(): boolean {
  const ts = useTransfers.getState();
  const bs = useBatches.getState();
  return ts.ids.some((id) => ts.byId[id] && isMoving(ts.byId[id])) || bs.ids.some((id) => batchPausable(bs.byId[id]?.status));
}

/** Is there anything Resume all would resume? */
export function canResumeAll(): boolean {
  const ts = useTransfers.getState();
  const bs = useBatches.getState();
  return ts.ids.some((id) => ts.byId[id]?.status === "paused") || bs.ids.some((id) => bs.byId[id]?.status === "paused");
}

/** Pause every queued or running transfer and folder transfer, or resume every paused one. */
export function setAllPaused(pause: boolean) {
  const ts = useTransfers.getState();
  for (const id of ts.ids) {
    const t = ts.byId[id];
    if (t && (pause ? isMoving(t) : t.status === "paused")) void setTransferPaused(id, pause);
  }
  const bs = useBatches.getState();
  for (const id of bs.ids) {
    const st = bs.byId[id]?.status;
    if (pause ? batchPausable(st) : st === "paused") void setBatchPaused(id, pause);
  }
}
