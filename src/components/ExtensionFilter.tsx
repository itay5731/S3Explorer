import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

/**
 * A drop-down for narrowing a list of files to chosen types. `counts` maps each file extension
 * present ("" for files without one) to how many files have it; `selected` holds the chosen ones,
 * and an empty selection means every type.
 */
export function ExtensionFilter({
  counts,
  selected,
  onChange,
}: {
  counts: Map<string, number>;
  selected: Set<string>;
  onChange(next: Set<string>): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = (ext: string) => (ext ? `.${ext}` : "No extension");
  const wanted = search.trim().toLowerCase().replace(/^\./, "");
  // Most common first, so the usual suspects are at the top.
  const options = [...counts].filter(([ext]) => ext.includes(wanted)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const toggle = (ext: string) => {
    const next = new Set(selected);
    if (!next.delete(ext)) next.add(ext);
    onChange(next);
  };

  return (
    <div className="ext-filter" ref={ref}>
      <button
        type="button"
        className={`ext-button ${selected.size ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Show only some file types"
      >
        <span className="ext-button-label">{selected.size ? [...selected].map(label).join(", ") : "Type"}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="ext-menu">
          <div className="search-box">
            <Search size={13} />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a type" spellCheck={false} />
          </div>
          <div className="ext-options">
            {options.map(([ext, count]) => (
              <label key={ext} className="ext-option">
                <input type="checkbox" checked={selected.has(ext)} onChange={() => toggle(ext)} />
                <span className="ext-name">{label(ext)}</span>
                <span className="ext-count">{count}</span>
              </label>
            ))}
            {options.length === 0 && <p className="recent-note">No type matches “{search.trim()}”.</p>}
          </div>
          {selected.size > 0 && (
            <button type="button" className="link-btn" onClick={() => onChange(new Set())}>
              Show every type
            </button>
          )}
        </div>
      )}
    </div>
  );
}
