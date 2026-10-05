// The single gateway between the UI and the backend.
// Inside Tauri every call goes through `invoke` / `listen`; in a plain browser
// (`npm run dev`) everything is routed to the in-memory mock in `./mock.ts`.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  TRANSFER_PROGRESS_EVENT,
  type AppError,
  type Bucket,
  type ConnectionConfig,
  type ConnectionInfo,
  type DeleteResult,
  type ErrorCode,
  type ListPage,
  type ObjectMeta,
  type ProfileInfo,
  type Transfer,
  type TransferSettings,
} from "./types";

export type Unlisten = () => void;

/** OS file drag & drop, normalized from the Tauri webview drag-drop event. */
export type FileDropEvent =
  | { type: "enter"; paths: string[] }
  | { type: "over" }
  | { type: "drop"; paths: string[] }
  | { type: "leave" };

export interface Backend {
  listProfiles(): Promise<ProfileInfo[]>;
  connect(config: ConnectionConfig): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  connectionStatus(): Promise<ConnectionInfo | null>;
  listBuckets(): Promise<Bucket[]>;
  listObjects(bucket: string, prefix: string, continuationToken?: string | null, pageSize?: number): Promise<ListPage>;
  headObject(bucket: string, key: string): Promise<ObjectMeta>;
  createFolder(bucket: string, prefix: string): Promise<void>;
  deleteFolder(bucket: string, prefix: string): Promise<DeleteResult>;
  startDownload(bucket: string, key: string, destPath: string): Promise<string>;
  startUpload(bucket: string, key: string, srcPath: string): Promise<string>;
  cancelTransfer(id: string): Promise<void>;
  removeTransfer(id: string): Promise<void>;
  listTransfers(): Promise<Transfer[]>;
  onTransferProgress(cb: (t: Transfer) => void): Promise<Unlisten>;
  getSettings(): Promise<TransferSettings>;
  updateSettings(settings: TransferSettings): Promise<TransferSettings>;
  // Platform helpers (dialogs, paths, shell, drag & drop)
  pickFiles(): Promise<string[]>;
  pickSavePath(defaultName: string): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  joinPath(dir: string, name: string): Promise<string>;
  revealInFolder(path: string): Promise<void>;
  onFileDrop(cb: (e: FileDropEvent) => void): Promise<Unlisten>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const ERROR_CODES: readonly string[] = [
  "NotConnected", "Auth", "NoSuchBucket", "NoSuchKey", "AccessDenied",
  "Network", "Io", "Cancelled", "InvalidInput", "Unknown",
];

/** Turn whatever `invoke` (or a plugin) rejected with into an `AppError`. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) {
    const obj = e as { code?: unknown; message?: unknown };
    const code: ErrorCode =
      typeof obj.code === "string" && ERROR_CODES.includes(obj.code) ? (obj.code as ErrorCode) : "Unknown";
    return { code, message: String(obj.message ?? "Unknown error") };
  }
  if (typeof e === "string") return { code: "Unknown", message: e };
  return { code: "Unknown", message: "Unknown error" };
}

const tauriBackend: Backend = {
  listProfiles: () => invoke<ProfileInfo[]>("list_profiles"),
  connect: (config) => invoke<ConnectionInfo>("connect", { config }),
  disconnect: () => invoke<void>("disconnect"),
  connectionStatus: () => invoke<ConnectionInfo | null>("connection_status"),
  listBuckets: () => invoke<Bucket[]>("list_buckets"),
  listObjects: (bucket, prefix, continuationToken, pageSize) =>
    invoke<ListPage>("list_objects", {
      bucket,
      prefix,
      continuationToken: continuationToken ?? null,
      pageSize: pageSize ?? null,
    }),
  headObject: (bucket, key) => invoke<ObjectMeta>("head_object", { bucket, key }),
  createFolder: (bucket, prefix) => invoke<void>("create_folder", { bucket, prefix }),
  deleteFolder: (bucket, prefix) => invoke<DeleteResult>("delete_folder", { bucket, prefix }),
  startDownload: (bucket, key, destPath) => invoke<string>("start_download", { bucket, key, destPath }),
  startUpload: (bucket, key, srcPath) => invoke<string>("start_upload", { bucket, key, srcPath }),
  cancelTransfer: (id) => invoke<void>("cancel_transfer", { id }),
  removeTransfer: (id) => invoke<void>("remove_transfer", { id }),
  listTransfers: () => invoke<Transfer[]>("list_transfers"),
  onTransferProgress: (cb) => listen<Transfer>(TRANSFER_PROGRESS_EVENT, (e) => cb(e.payload)),
  getSettings: () => invoke<TransferSettings>("get_settings"),
  updateSettings: (settings) => invoke<TransferSettings>("update_settings", { settings }),

  async pickFiles() {
    const res = await open({ multiple: true, directory: false, title: "Upload files" });
    if (!res) return [];
    return Array.isArray(res) ? res : [res];
  },
  async pickSavePath(defaultName) {
    return (await save({ defaultPath: defaultName, title: "Download to" })) ?? null;
  },
  async pickDirectory() {
    const res = await open({ directory: true, multiple: false, title: "Download into folder" });
    return typeof res === "string" ? res : null;
  },
  joinPath: (dir, name) => join(dir, name),
  revealInFolder: (path) => revealItemInDir(path),
  onFileDrop: (cb) =>
    getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      switch (p.type) {
        case "enter":
          cb({ type: "enter", paths: p.paths });
          break;
        case "over":
          cb({ type: "over" });
          break;
        case "drop":
          cb({ type: "drop", paths: p.paths });
          break;
        case "leave":
          cb({ type: "leave" });
          break;
      }
    }),
};

let backendPromise: Promise<Backend> | null = null;
function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri ? Promise.resolve(tauriBackend) : import("./mock").then((m) => m.mockBackend);
  }
  return backendPromise;
}

type Fn<K extends keyof Backend> = Backend[K] extends (...a: infer A) => Promise<infer R> ? (...a: A) => Promise<R> : never;

/** Call a backend method; always rejects with a normalized `AppError`. */
async function call<K extends keyof Backend>(
  name: K,
  ...args: Parameters<Fn<K>>
): Promise<Awaited<ReturnType<Fn<K>>>> {
  try {
    const b = await backend();
    const fn = b[name] as unknown as (...a: Parameters<Fn<K>>) => ReturnType<Fn<K>>;
    return await fn.apply(b, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const listProfiles = () => call("listProfiles");
export const connect = (config: ConnectionConfig) => call("connect", config);
export const disconnect = () => call("disconnect");
export const connectionStatus = () => call("connectionStatus");
export const listBuckets = () => call("listBuckets");
export const listObjects = (bucket: string, prefix: string, continuationToken?: string | null, pageSize?: number) =>
  call("listObjects", bucket, prefix, continuationToken, pageSize);
export const headObject = (bucket: string, key: string) => call("headObject", bucket, key);
export const createFolder = (bucket: string, prefix: string) => call("createFolder", bucket, prefix);
export const deleteFolder = (bucket: string, prefix: string) => call("deleteFolder", bucket, prefix);
export const startDownload = (bucket: string, key: string, destPath: string) =>
  call("startDownload", bucket, key, destPath);
export const startUpload = (bucket: string, key: string, srcPath: string) => call("startUpload", bucket, key, srcPath);
export const cancelTransfer = (id: string) => call("cancelTransfer", id);
export const removeTransfer = (id: string) => call("removeTransfer", id);
export const listTransfers = () => call("listTransfers");
export const onTransferProgress = (cb: (t: Transfer) => void) => call("onTransferProgress", cb);
export const getSettings = () => call("getSettings");
export const updateSettings = (settings: TransferSettings) => call("updateSettings", settings);

export const pickFiles = () => call("pickFiles");
export const pickSavePath = (defaultName: string) => call("pickSavePath", defaultName);
export const pickDirectory = () => call("pickDirectory");
export const joinPath = (dir: string, name: string) => call("joinPath", dir, name);
export const revealInFolder = (path: string) => call("revealInFolder", path);
export const onFileDrop = (cb: (e: FileDropEvent) => void) => call("onFileDrop", cb);
