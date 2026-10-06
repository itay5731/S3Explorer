import { create } from "zustand";
import type { AppError } from "../lib/types";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Optional button; clicking it runs the action and dismisses the toast. */
  action?: ToastAction;
}

export interface ToastAction {
  label: string;
  run(): void;
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, "id">, ttlMs?: number): void;
  dismiss(id: number): void;
}

let seq = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t, ttlMs) {
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-4), { ...t, id }] });
    const ttl = ttlMs ?? (t.kind === "error" || t.action ? 8000 : 3500);
    setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((x) => x.id !== id) });
  },
}));

export const toast = {
  success: (title: string, detail?: string, action?: ToastAction) =>
    useToasts.getState().push({ kind: "success", title, detail, action }),
  warning: (title: string, detail?: string, action?: ToastAction) =>
    useToasts.getState().push({ kind: "warning", title, detail, action }),
  info: (title: string, detail?: string, action?: ToastAction) =>
    useToasts.getState().push({ kind: "info", title, detail, action }),
  error: (title: string, err?: AppError | string, action?: ToastAction) =>
    useToasts.getState().push({
      kind: "error",
      title,
      detail: typeof err === "string" ? err : err?.message,
      action,
    }),
};

/** "You don't have permission to <action> on this bucket" (see "Shared buckets" in docs/CONTRACT.md). */
export const permissionText = (action: string) => `You don’t have permission to ${action} on this bucket`;

/** True for an AccessDenied error, or an error text (e.g. a failed transfer's) that says access was denied. */
export function isDenied(e: AppError | string | null | undefined): boolean {
  if (!e) return false;
  if (typeof e === "string") return /\bAccessDenied\b|\bAccess Denied\b/i.test(e);
  return e.code === "AccessDenied";
}

/**
 * The start of the backend's message when a save's write succeeded but reading the result back did
 * not (put_lifecycle, put_bucket_tags, put_object_tags): the save probably applied.
 */
export const SAVED_UNREAD_PREFIX = "Saved, but reading back failed";

/** "Nothing was changed" is only true for errors the backend raises before writing anything. */
export const nothingWritten = (e: AppError) => e.code === "InvalidInput" || e.code === "AccessDenied";

const recentDenied = new Map<string, number>();
/** How long an identical permission toast is suppressed: one toast per problem, not one per file. */
const DENIED_QUIET_MS = 6000;

/**
 * Report a permission error once: the same message within a few seconds (e.g. several files of one
 * upload) shows a single toast. Nothing is retried.
 */
export function toastDenied(action: string, err?: AppError | string) {
  const title = permissionText(action);
  const now = Date.now();
  if (now - (recentDenied.get(title) ?? 0) < DENIED_QUIET_MS) return;
  recentDenied.set(title, now);
  toast.error(title, err);
}

/** `toast.error`, except that a permission error gets the plain permission message (once). */
export function toastFailure(title: string, err: AppError | string | undefined, action: string) {
  if (isDenied(err)) toastDenied(action, err);
  else toast.error(title, err);
}
