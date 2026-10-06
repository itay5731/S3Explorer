// A small menu at a point, styled like the table's context menu (.context-menu / .menu-item):
// closes on a click outside, Esc, resize, blur or scroll; arrow keys move between items.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface PopupMenuItem {
  label: string;
  icon: ReactNode;
  action(): void;
  danger?: boolean;
  disabled?: boolean;
}

export function PopupMenu({ x, y, groups, onClose, label }: { x: number; y: number; groups: PopupMenuItem[][]; onClose(): void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = Math.max(6, Math.min(x, window.innerWidth - r.width - 6));
    const py = y + r.height > window.innerHeight - 6 ? Math.max(6, y - r.height) : y;
    setPos({ x: px, y: py });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => closeRef.current();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
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
  }, []);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: pos?.x ?? x, top: pos?.y ?? y, visibility: pos ? "visible" : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {groups
        .filter((g) => g.length)
        .map((g, gi) => (
          <div key={gi} className="menu-group">
            {g.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`menu-item ${item.danger ? "danger" : ""}`}
                disabled={item.disabled}
                onClick={() => {
                  closeRef.current();
                  item.action();
                }}
              >
                {item.icon}
                <span className="menu-label">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
}
