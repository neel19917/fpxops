import { useMemo, type ReactNode } from "react";

// Minimal Markdown renderer for the brief: headings, paragraphs, bullet and
// numbered lists, pipe tables, blockquotes, rules, **bold**, `code`. Tracking
// numbers that exist on the board become links into the task drawer. Kept
// deliberately small rather than pulling in a Markdown library for one panel.
export function MarkdownLite({ text, trackingIndex, onOpenTask }: { text: string; trackingIndex: Map<string, string>; onOpenTask: (taskId: string) => void }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  const inline = (s: string, key: string) => renderInline(s, key, trackingIndex, onOpenTask);
  return (
    <div className="text-sm text-slate-800 leading-relaxed space-y-2 max-w-none">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.type) {
          case "h1": return <h2 key={k} className="text-lg font-semibold text-slate-900 mt-2">{inline(b.text, k)}</h2>;
          case "h2": return <h3 key={k} className="text-sm font-semibold uppercase tracking-wide text-violet-800 mt-4 border-b border-violet-100 pb-1">{inline(b.text, k)}</h3>;
          case "h3": return <h4 key={k} className="text-sm font-semibold text-slate-900 mt-2">{inline(b.text, k)}</h4>;
          case "hr": return <hr key={k} className="border-slate-200" />;
          case "quote": return <blockquote key={k} className="border-l-2 border-slate-300 pl-3 text-slate-600 italic">{inline(b.text, k)}</blockquote>;
          case "ul": return <ul key={k} className="list-disc pl-5 space-y-0.5">{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ul>;
          case "ol": return <ol key={k} className="list-decimal pl-5 space-y-0.5">{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ol>;
          case "table": return (
            <div key={k} className="overflow-x-auto">
              <table className="text-xs w-full ring-1 ring-slate-200 rounded-lg overflow-hidden">
                <thead className="bg-slate-50 text-slate-600 uppercase tracking-wide text-[10px]"><tr>{b.header.map((h, j) => <th key={j} className="text-left px-2 py-1.5 font-semibold">{inline(h, `${k}h${j}`)}</th>)}</tr></thead>
                <tbody>{b.rows.map((r, ri) => <tr key={ri} className="border-t border-slate-100">{r.map((c, ci) => <td key={ci} className="px-2 py-1.5 align-top">{inline(c, `${k}r${ri}c${ci}`)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
          default: return <p key={k}>{inline(b.text, k)}</p>;
        }
      })}
    </div>
  );
}

type MdBlock =
  | { type: "h1" | "h2" | "h3" | "p" | "quote"; text: string }
  | { type: "hr" }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "table"; header: string[]; rows: string[][] };

function parseMarkdownBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  const splitRow = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    if (/^-{3,}$|^\*{3,}$/.test(t)) { out.push({ type: "hr" }); i++; continue; }
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push({ type: h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : "h3", text: h[2] }); i++; continue; }
    if (t.startsWith(">")) { out.push({ type: "quote", text: t.replace(/^>\s?/, "") }); i++; continue; }
    if (t.startsWith("|")) {
      const header = splitRow(t); i++;
      if (i < lines.length && /^\|?\s*:?-{2,}/.test(lines[i].trim())) i++;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(splitRow(lines[i])); i++; }
      out.push({ type: "table", header, rows });
      continue;
    }
    if (/^[-*•]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { items.push(lines[i].trim().replace(/^[-*•]\s+/, "")); i++; }
      out.push({ type: "ul", items }); continue;
    }
    if (/^\d+[.)]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].trim().replace(/^\d+[.)]\s+/, "")); i++; }
      out.push({ type: "ol", items }); continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|[-*•]\s|\d+[.)]\s|\||>)/.test(lines[i].trim())) { para.push(lines[i].trim()); i++; }
    out.push({ type: "p", text: para.join(" ") });
  }
  return out;
}

// **bold**, `code`, and tracking-number links. Tracking numbers are matched
// as 6-14 digit runs (optionally "-N" suffix) that exist on the board.
function renderInline(s: string, key: string, trackingIndex: Map<string, string>, onOpenTask: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\b\d{6,14}(?:-\d)?\b)/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (tok.startsWith("**")) out.push(<strong key={k} className="font-semibold text-slate-900">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="font-mono text-[12px] bg-slate-100 rounded px-1">{tok.slice(1, -1)}</code>);
    else if (trackingIndex.has(tok)) out.push(<button key={k} type="button" onClick={() => onOpenTask(trackingIndex.get(tok)!)} className="font-mono text-sky-700 hover:underline" title="Open in FPX">{tok}</button>);
    else out.push(tok);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
