import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ClipboardPaste, Copy, CopyPlus, Download, FolderOpen, FolderPlus, Info, Link, PencilLine, RefreshCw, Scissors, Trash2, Upload } from "lucide-react";
import { navigate, openContextMenu, openModal, refresh, setDetailsOpen, setSelection, useApp } from "../store/app";
import { copyText, downloadObjects, pickAndUpload } from "../store/actions";
import { getSelected } from "../store/view";
import { useClipboard } from "../store/clipboard";
import { copySelection, requestDelete, requestPaste, requestRename } from "../store/ops";
import { s3Uri } from "../lib/format";
import { plural } from "../lib/ops";

interface Item {
  label: string;
  icon: ReactNode;
  action: () => void;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
}

export function ContextMenu() {
  const menu = useApp((s) => s.contextMenu);
  const bucket = useApp((s) => s.bucket);
  const clip = useClipboard((s) => s.clip);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 6);
    const y = menu.y + r.height > window.innerHeight - 6 ? Math.max(6, menu.y - r.height) : menu.y;
    setPos({ x: Math.max(6, x), y });
    ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => openContextMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        btns[next]?.focus();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu]);

  if (!menu || !bucket) return null;

  const { folders, objects } = getSelected();
  const groups: Item[][] = [];
  const count = folders.length + objects.length;

  const pasteItem: Item = {
    label: clip ? `Paste ${plural(clip.items.length, "item")} here` : "Paste",
    icon: <ClipboardPaste size={14} />,
    action: () => requestPaste(),
    hint: "Ctrl+V",
    disabled: !clip,
  };
  const editItems = (n: number): Item[] => [
    { label: n > 1 ? `Copy ${n} items` : "Copy", icon: <CopyPlus size={14} />, action: () => copySelection("copy"), hint: "Ctrl+C" },
    { label: n > 1 ? `Cut ${n} items` : "Cut", icon: <Scissors size={14} />, action: () => copySelection("cut"), hint: "Ctrl+X" },
    ...(n === 1 ? [{ label: "Rename…", icon: <PencilLine size={14} />, action: () => requestRename(), hint: "F2" }] : []),
  ];
  const deleteItem = (n: number, folder: boolean): Item => ({
    label: n > 1 ? `Delete ${n} items…` : folder ? "Delete folder…" : "Delete…",
    icon: <Trash2 size={14} />,
    danger: true,
    action: () => requestDelete(),
    hint: "Del",
  });

  if (count === 0) {
    groups.push([
      { label: "Upload files…", icon: <Upload size={14} />, action: () => void pickAndUpload() },
      { label: "New folder…", icon: <FolderPlus size={14} />, action: () => openModal({ kind: "newFolder" }) },
    ]);
    groups.push([pasteItem]);
    groups.push([{ label: "Refresh", icon: <RefreshCw size={14} />, action: () => refresh() }]);
  } else if (count === 1 && folders.length === 1) {
    const f = folders[0];
    groups.push([{ label: "Open", icon: <FolderOpen size={14} />, action: () => navigate(bucket, f.prefix), hint: "Enter" }]);
    groups.push([
      { label: "Copy key", icon: <Copy size={14} />, action: () => void copyText(f.prefix, "Key") },
      { label: "Copy S3 URI", icon: <Link size={14} />, action: () => void copyText(s3Uri(bucket, f.prefix), "S3 URI") },
    ]);
    groups.push(editItems(1));
    groups.push([deleteItem(1, true)]);
  } else if (count === 1) {
    const o = objects[0];
    groups.push([{ label: "Download…", icon: <Download size={14} />, action: () => void downloadObjects([o]) }]);
    groups.push([
      { label: "Copy key", icon: <Copy size={14} />, action: () => void copyText(o.key, "Key") },
      { label: "Copy S3 URI", icon: <Link size={14} />, action: () => void copyText(s3Uri(bucket, o.key), "S3 URI") },
    ]);
    groups.push(editItems(1));
    groups.push([
      {
        label: "Properties",
        icon: <Info size={14} />,
        action: () => {
          setSelection(new Set([o.key]), o.key, o.key);
          setDetailsOpen(true);
        },
      },
    ]);
    groups.push([deleteItem(1, false)]);
  } else {
    const keys = [...folders.map((f) => f.prefix), ...objects.map((o) => o.key)];
    if (objects.length) {
      groups.push([
        {
          label: `Download ${objects.length} object${objects.length === 1 ? "" : "s"}…`,
          icon: <Download size={14} />,
          action: () => void downloadObjects(objects),
        },
      ]);
    }
    groups.push([
      { label: `Copy ${keys.length} keys`, icon: <Copy size={14} />, action: () => void copyText(keys.join("\n"), "Keys") },
      {
        label: `Copy ${keys.length} S3 URIs`,
        icon: <Link size={14} />,
        action: () => void copyText(keys.map((k) => s3Uri(bucket, k)).join("\n"), "S3 URIs"),
      },
    ]);
    groups.push(editItems(count));
    groups.push([deleteItem(count, false)]);
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {groups.map((g, gi) => (
        <div key={gi} className="menu-group">
          {g.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                openContextMenu(null);
                item.action();
              }}
            >
              {item.icon}
              <span className="menu-label">{item.label}</span>
              {item.hint && <span className="menu-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
