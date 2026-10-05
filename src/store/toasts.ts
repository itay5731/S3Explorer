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
