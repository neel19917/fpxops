import { useState } from "react";
import { FilePlus2, Info, Loader2, Sparkles } from "lucide-react";
import { aiDraft, createDraft, type Draft, type Message } from "../../lib/mailboxApi";
import { fmtRelative } from "../../lib/format";
import { ErrorBlock } from "../ErrorBlock";
import { messageTime } from "./shared";

interface Props {
  target: Message | null;
  onCreated: (draft: Draft) => void;
}

// Writes a reply and saves it as a DRAFT in the mailbox's Outlook. Nothing is
// sent from FPX: someone opens the draft in Outlook and sends it from there.
export function ReplyComposer({ target, onCreated }: Props) {
  const [body, setBody] = useState("");
  const [replyAll, setReplyAll] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);
  const [showInstr, setShowInstr] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState<"ai" | "draft" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!target) {
    return <div className="text-sm text-slate-500 px-1">There is no message in this conversation to reply to.</div>;
  }

  const writeWithAi = async () => {
    if (body.trim() && !window.confirm("Replace what you have written with an AI draft?")) return;
    setBusy("ai");
    setErr(null);
    try {
      const r = await aiDraft(target.id, instructions);
      setBody(r.body || "");
      setAiUsed(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    if (!body.trim()) return;
    setBusy("draft");
    setErr(null);
    try {
      const r = await createDraft(target.id, { body, reply_all: replyAll, ai_generated: aiUsed });
      onCreated(r.draft);
      setBody("");
      setAiUsed(false);
      setInstructions("");
      setShowInstr(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const who = target.direction === "out" ? "FreightPOP Support" : (target.from_name || target.from_address || "sender");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-500 min-w-0 truncate">
          Replying to <span className="font-medium text-slate-700">{who}</span> · {fmtRelative(messageTime(target))}
        </span>
        <div className="ml-auto inline-flex rounded-lg ring-1 ring-slate-200 bg-white p-0.5 text-xs" role="radiogroup" aria-label="Reply type">
          {([[false, "Reply"], [true, "Reply all"]] as const).map(([v, label]) => (
            <button key={label} type="button" role="radio" aria-checked={replyAll === v} onClick={() => setReplyAll(v)}
              className={"px-2.5 py-1 rounded-md " + (replyAll === v ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-50")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {showInstr ? (
        <input
          type="text"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Optional: tell the AI what to say (e.g. apologize for the delay, ask for the PRO number)"
          className="w-full text-sm rounded-lg ring-1 ring-slate-200 px-3 py-1.5 focus:outline-none focus:ring-violet-400"
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) { e.preventDefault(); writeWithAi(); } }}
        />
      ) : null}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={7}
        placeholder="Write your reply…"
        className="w-full text-sm rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:outline-none focus:ring-violet-400 resize-y"
        disabled={busy === "ai"}
      />

      {err ? <ErrorBlock compact>{err}</ErrorBlock> : null}

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => (showInstr ? writeWithAi() : setShowInstr(true))} disabled={!!busy}
          className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-60">
          {busy === "ai" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy === "ai" ? "Writing…" : showInstr ? "Write it" : "Write with AI"}
        </button>
        {showInstr && !busy ? (
          <button type="button" onClick={() => setShowInstr(false)} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
        ) : null}
        <button type="button" onClick={saveDraft} disabled={!!busy || !body.trim()}
          className="ml-auto inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
          {busy === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />}
          Create draft in Outlook
        </button>
      </div>
      <p className="text-[11px] text-slate-500 flex items-start gap-1">
        <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
        This only saves a draft in the support mailbox's Outlook Drafts folder. Nothing is sent. Open the draft in Outlook to review and send it.
      </p>
    </div>
  );
}
