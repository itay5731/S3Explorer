// A deliberately small, safe Markdown renderer for release notes. It produces React elements only
// (never HTML strings): headings, paragraphs, bullet and numbered lists, bold, italic and inline
// code. Links are shown as their text; raw HTML is stripped and never interpreted.

import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Remove HTML comments, script/style blocks and tags; the remaining text is rendered as text. */
function stripHtml(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?[a-z][^>]*>/gi, "");
}

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let inFence = false;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };
  for (const raw of stripHtml(src).replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      // Code fences: keep their lines as plain paragraphs.
      inFence = !inFence;
      flushPara();
      flushList();
      continue;
    }
    if (inFence) {
      if (line.trim()) blocks.push({ kind: "para", text: "`" + line.trim().replace(/`/g, "'") + "`" });
      continue;
    }
    if (!line.trim() || RULE.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const ordered = !!n;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((b ?? n)![1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) {
      // Continuation line of the previous list item.
      list.items[list.items.length - 1] += " " + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim().replace(/^>\s?/, ""));
  }
  flushPara();
  flushList();
  return blocks;
}

// Inline: `code`, **bold** / __bold__, *italic* / _italic_, [text](url) -> text, <url> -> url.
const INLINE = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|\b_(?!\s)(.+?)_\b|!?\[([^\]]*)\]\([^)]*\)/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${i++}`;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{renderInline(m[3] ?? m[4], key)}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={key}>{renderInline(m[5] ?? m[6], key)}</em>);
    else out.push(...renderInline(m[7] ?? "", key));
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={`md ${className}`}>
      {blocks.map((b, i) => {
        const key = String(i);
        if (b.kind === "heading") {
          // Release notes sit under the dialog's own headings, so start at h4.
          const level = Math.min(6, b.level + 3);
          const Tag = `h${level}` as "h4" | "h5" | "h6";
          return (
            <Tag key={key} className={`md-h md-h${Math.min(b.level, 3)}`}>
              {renderInline(b.text, key)}
            </Tag>
          );
        }
        if (b.kind === "list") {
          const items = b.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>);
          return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
        }
        return <p key={key}>{renderInline(b.text, key)}</p>;
      })}
    </div>
  );
}
