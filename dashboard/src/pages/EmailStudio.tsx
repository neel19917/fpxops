import { useCallback, useEffect, useMemo, useState } from "react";
import { Mail, Sparkles, Save, RotateCcw, Undo2, Eye, AlertTriangle, CheckCircle2 } from "lucide-react";
import { api, type EmailStudioSample, type EmailStudioType, type SettingRow } from "../lib/api";
import { fmtRelative } from "../lib/format";
import { ErrorBlock } from "../components/ErrorBlock";
import { LoadingState } from "../components/LoadingState";

// Email Studio: edit the AI email-draft prompts, have Claude rewrite them
// from plain-English instructions, and preview the result on real shipments
// before saving. Saving writes the same settings the email drafts read.

type Part = { key: string; label: string; hint: string };
type EmailDef = { id: EmailStudioType; label: string; blurb: string; parts: Part[]; modelKey: string; group: boolean };

const EMAILS: EmailDef[] = [
  {
    id: "carrier", label: "Single email → carrier", group: false,
    blurb: "The “Draft email” button on one shipment, written to the carrier.",
    modelKey: "prompt.email_draft.model",
    parts: [
      { key: "prompt.email_draft.system_base", label: "Main instructions", hint: "Shared by both single-shipment emails (carrier and customer). {{audienceCopy}} is where the audience part goes." },
      { key: "prompt.email_draft.audience_carrier", label: "Carrier audience", hint: "Who the email is for and what to ask the carrier." },
    ],
  },
  {
    id: "customer", label: "Single email → customer", group: false,
    blurb: "The “Draft email” button on one shipment, written to the customer.",
    modelKey: "prompt.email_draft.model",
    parts: [
      { key: "prompt.email_draft.system_base", label: "Main instructions", hint: "Shared by both single-shipment emails (carrier and customer). {{audienceCopy}} is where the audience part goes." },
      { key: "prompt.email_draft.audience_customer", label: "Customer audience", hint: "Who the email is for and how much detail they get." },
    ],
  },
  {
    id: "carrier_group", label: "Group email → carrier", group: true,
    blurb: "One email to a carrier covering several shipments (Tasks → carrier follow-ups).",
    modelKey: "prompt.email_draft.carrier_group.model",
    parts: [
      { key: "prompt.email_draft.carrier_group.system_base", label: "Main instructions", hint: "{{audienceCopy}} is where the audience part goes." },
      { key: "prompt.email_draft.carrier_group.audience", label: "Carrier audience", hint: "Who the email is for and what to ask." },
    ],
  },
  {
    id: "customer_group", label: "Group email → customer", group: true,
    blurb: "One email to a customer covering several shipments (Tasks → customer follow-ups).",
    modelKey: "prompt.email_draft.customer_group.model",
    parts: [
      { key: "prompt.email_draft.customer_group.system_base", label: "Main instructions", hint: "{{audienceCopy}} is where the audience part goes." },
      { key: "prompt.email_draft.customer_group.audience", label: "Customer audience", hint: "Who the email is for and how much detail they get." },
    ],
  },
];

const MODELS = [
  { value: "claude-haiku-5-5", label: "Haiku 5.5 — cheapest, fast" },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5 — balanced" },
  { value: "claude-opus-5-5", label: "Opus 5.5 — best quality" },
];

const asText = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));

export function EmailStudioPage() {
  const [rows, setRows] = useState<Map<string, SettingRow> | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // unsaved edits by key
  const [emailId, setEmailId] = useState<EmailStudioType>("carrier");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const r = await api.settings.list();
      setRows(new Map(r.data.filter((s) => s.key.startsWith("prompt.email_draft.")).map((s) => [s.key, s])));
    } catch (e) { setLoadErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const email = EMAILS.find((e) => e.id === emailId)!;
  const saved = (key: string) => asText(rows?.get(key)?.value);
  const current = (key: string) => (key in drafts ? drafts[key] : saved(key));
  const dirtyKeys = useMemo(() => Object.keys(drafts).filter((k) => drafts[k] !== saved(k)), [drafts, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirtyKeys.length) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirtyKeys.length]);

  function edit(key: string, value: string) { setDrafts((d) => ({ ...d, [key]: value })); setMsg(null); }
  function discard(key: string) { setDrafts((d) => { const n = { ...d }; delete n[key]; return n; }); }

  async function saveAll() {
    if (!dirtyKeys.length) return;
    if (!confirm(`Save ${dirtyKeys.length} change(s)? New email drafts start using them right away.`)) return;
    setSaving(true); setMsg(null);
    try {
      for (const k of dirtyKeys) await api.settings.update(k, drafts[k]);
      setDrafts({});
      await load();
      setMsg({ tone: "ok", text: `Saved ${dirtyKeys.length} change(s). New drafts use them now.` });
    } catch (e) { setMsg({ tone: "err", text: `Save failed: ${(e as Error).message}` }); }
    finally { setSaving(false); }
  }

  if (loadErr) return <ErrorBlock>{loadErr} <button onClick={load} className="underline ml-1">Retry</button></ErrorBlock>;
  if (!rows) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Mail className="h-5 w-5 text-violet-600" /> Email Studio</h1>
          <p className="text-sm text-slate-500 mt-0.5">Edit how FPX's AI writes emails. Rewrite with plain-English instructions, preview on real shipments, then save.</p>
        </div>
        <div className="flex items-center gap-2">
          {dirtyKeys.length ? <span className="text-sm text-amber-700">{dirtyKeys.length} unsaved change(s)</span> : <span className="text-sm text-slate-400">No unsaved changes</span>}
          <button onClick={() => setDrafts({})} disabled={!dirtyKeys.length || saving}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg ring-1 ring-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40">
            <Undo2 className="h-4 w-4" /> Discard all
          </button>
          <button onClick={saveAll} disabled={!dirtyKeys.length || saving}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
            <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {msg ? (
        <div className={"rounded-xl p-3 text-sm ring-1 " + (msg.tone === "ok" ? "bg-emerald-50 ring-emerald-200 text-emerald-800" : "bg-rose-50 ring-rose-200 text-rose-800")}>{msg.text}</div>
      ) : null}

      <div className="flex gap-1 flex-wrap border-b border-slate-200">
        {EMAILS.map((e) => {
          const dirty = [...e.parts.map((p) => p.key), e.modelKey].some((k) => dirtyKeys.includes(k));
          return (
            <button key={e.id} onClick={() => setEmailId(e.id)}
              className={"px-3 py-2 text-sm -mb-px border-b-2 " + (e.id === emailId ? "border-violet-600 text-violet-700 font-medium" : "border-transparent text-slate-600 hover:text-slate-900")}>
              {e.label}{dirty ? <span className="ml-1 text-amber-600">•</span> : null}
            </button>
          );
        })}
      </div>
      <p className="text-sm text-slate-600">{email.blurb}</p>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4 min-w-0">
          {email.parts.map((p) => (
            <PromptEditor key={p.key} part={p} row={rows.get(p.key)} value={current(p.key)} savedValue={saved(p.key)}
              onChange={(v) => edit(p.key, v)} onDiscard={() => discard(p.key)} />
          ))}
          <ModelPicker value={current(email.modelKey)} savedValue={saved(email.modelKey)}
            shared={email.id === "carrier" || email.id === "customer"} onChange={(v) => edit(email.modelKey, v)} />
        </div>
        <PreviewPanel email={email} overrides={Object.fromEntries(dirtyKeys.map((k) => [k, drafts[k]]))} />
      </div>
    </div>
  );
}

function PromptEditor({ part, row, value, savedValue, onChange, onDiscard }: {
  part: Part; row?: SettingRow; value: string; savedValue: string; onChange: (v: string) => void; onDiscard: () => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);
  const [beforeRewrite, setBeforeRewrite] = useState<string | null>(null);
  const dirty = value !== savedValue;
  const def = asText(row?.default);

  async function rewrite() {
    if (!instructions.trim()) return;
    setBusy(true); setNote(null);
    try {
      const r = await api.emailStudio.rewrite({ key: part.key, text: value, instructions });
      setBeforeRewrite(value);
      onChange(r.text);
      setNote(r.warnings.length ? { tone: "warn", text: r.warnings.join(" ") } : { tone: "ok", text: "Rewritten — not saved yet. Preview it, then Save changes." });
    } catch (e) { setNote({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-slate-900">{part.label} {dirty ? <span className="text-xs text-amber-700 font-normal">· edited</span> : null}</div>
          <div className="text-xs text-slate-500">{part.hint}</div>
          {row?.updated_at ? <div className="text-xs text-slate-400 mt-0.5">Last saved {fmtRelative(row.updated_at)}{row.updated_by ? ` by ${row.updated_by}` : ""}</div> : <div className="text-xs text-slate-400 mt-0.5">Using the built-in default</div>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {dirty ? (
            <button onClick={() => { onDiscard(); setBeforeRewrite(null); setNote(null); }} title="Back to the saved version"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-slate-200 hover:bg-slate-50"><Undo2 className="h-3.5 w-3.5" /> Undo edits</button>
          ) : null}
          {def && value !== def ? (
            <button onClick={() => { if (confirm("Replace with the built-in default wording? (Not saved until you click Save changes.)")) onChange(def); }}
              title="Load the original built-in wording" className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-slate-200 hover:bg-slate-50">
              <RotateCcw className="h-3.5 w-3.5" /> Default
            </button>
          ) : null}
        </div>
      </div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} spellCheck
        className="w-full min-h-[220px] text-sm font-mono leading-relaxed rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-400 p-3 outline-none resize-y" />
      <div className="rounded-xl bg-violet-50/60 ring-1 ring-violet-100 p-3 space-y-2">
        <div className="text-xs font-medium text-violet-900 flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Rewrite with AI</div>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2}
          placeholder="e.g. Make the emails shorter. Sign off as “Freight Support” only. Subject to carriers: PRO #."
          className="w-full text-sm rounded-lg ring-1 ring-violet-200 focus:ring-2 focus:ring-violet-400 p-2 outline-none bg-white" />
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={rewrite} disabled={busy || !instructions.trim()}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
            <Sparkles className="h-4 w-4" /> {busy ? "Rewriting… (up to a minute)" : "Rewrite"}
          </button>
          {beforeRewrite != null ? (
            <button onClick={() => { onChange(beforeRewrite); setBeforeRewrite(null); setNote(null); }}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded ring-1 ring-violet-200 bg-white hover:bg-violet-50"><Undo2 className="h-3.5 w-3.5" /> Undo rewrite</button>
          ) : null}
          {note ? (
            <span className={"text-xs inline-flex items-center gap-1 " + (note.tone === "ok" ? "text-emerald-700" : note.tone === "warn" ? "text-amber-700" : "text-rose-700")}>
              {note.tone === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />} {note.text}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ModelPicker({ value, savedValue, shared, onChange }: {
  value: string; savedValue: string; shared: boolean; onChange: (v: string) => void;
}) {
  const known = MODELS.some((m) => m.value === value);
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-4 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <div className="font-medium text-slate-900">AI model {value !== savedValue ? <span className="text-xs text-amber-700 font-normal">· edited</span> : null}</div>
        <div className="text-xs text-slate-500">{shared ? "Shared by both single-shipment emails. " : ""}Cheaper models cost less per email; preview to compare quality.</div>
      </div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 bg-white">
        {!known ? <option value={value}>{value || "(default)"}</option> : null}
        {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </div>
  );
}

function PreviewPanel({ email, overrides }: { email: EmailDef; overrides: Record<string, string> }) {
  const [samples, setSamples] = useState<EmailStudioSample[] | null>(null);
  const [sampleErr, setSampleErr] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ subject: string; body: string; model: string | null; edited: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.emailStudio.samples().then((r) => setSamples(r.data)).catch((e) => setSampleErr((e as Error).message));
  }, []);
  useEffect(() => { setGroup(""); setPicked([]); setOut(null); setErr(null); }, [email.id]);

  const byCarrier = email.id === "carrier" || email.id === "carrier_group";
  const relevant = (samples || []).filter((s) => (byCarrier ? s.carrier : s.customer));
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of relevant) { const g = (byCarrier ? s.carrier : s.customer) || ""; m.set(g, (m.get(g) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [samples, byCarrier]); // eslint-disable-line react-hooks/exhaustive-deps
  const inGroup = relevant.filter((s) => !group || (byCarrier ? s.carrier : s.customer) === group);

  function toggle(tn: string) {
    setPicked((p) => email.group ? (p.includes(tn) ? p.filter((x) => x !== tn) : [...p, tn].slice(0, 12)) : [tn]);
  }

  async function run() {
    const manualTns = manual.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const tns = manualTns.length ? manualTns : picked;
    if (!tns.length) { setErr("Pick a shipment (or type a tracking number)."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.emailStudio.preview({ type: email.id, tracking_numbers: email.group ? tns : tns.slice(0, 1), notes: notes || undefined, group: email.group && group ? group : undefined, overrides });
      setOut({ subject: r.subject, body: r.body, model: r.model, edited: Object.keys(overrides).length > 0 });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm p-4 space-y-3 min-w-0 xl:sticky xl:top-4 self-start">
      <div>
        <div className="font-medium text-slate-900 flex items-center gap-1.5"><Eye className="h-4 w-4 text-violet-600" /> Preview</div>
        <div className="text-xs text-slate-500">Drafts a sample email with your edits (saved or not). Nothing is sent.</div>
      </div>
      {sampleErr ? <div className="text-xs text-rose-700">{sampleErr}</div> : null}
      {samples ? (
        <>
          <div className="flex gap-2 items-center flex-wrap">
            <select value={group} onChange={(e) => { setGroup(e.target.value); setPicked([]); }}
              className="text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 bg-white max-w-full">
              <option value="">{byCarrier ? "All carriers" : "All customers"}</option>
              {groups.map(([g, n]) => <option key={g} value={g}>{g} ({n})</option>)}
            </select>
            <span className="text-xs text-slate-500">{email.group ? "Pick up to 12 shipments (same " + (byCarrier ? "carrier" : "customer") + " works best)" : "Pick one shipment"}</span>
          </div>
          <div className="max-h-56 overflow-auto rounded-lg ring-1 ring-slate-100 divide-y divide-slate-100">
            {inGroup.slice(0, 80).map((s) => (
              <label key={s.tracking_number} className="flex items-start gap-2 px-2 py-1.5 text-xs hover:bg-slate-50 cursor-pointer">
                <input type={email.group ? "checkbox" : "radio"} name="studio-pick" checked={picked.includes(s.tracking_number)} onChange={() => toggle(s.tracking_number)} className="mt-0.5 accent-violet-600" />
                <span className="min-w-0">
                  <span className="font-mono text-slate-800">{s.tracking_number}</span>
                  <span className="text-slate-500"> · {byCarrier ? s.carrier : s.customer} · {s.status || "—"}</span>
                  <span className="block text-slate-400 truncate">{s.task}</span>
                </span>
              </label>
            ))}
            {!inGroup.length ? <div className="px-2 py-3 text-xs text-slate-400">No shipments with open tasks here — type tracking numbers below.</div> : null}
          </div>
        </>
      ) : !sampleErr ? <div className="text-xs text-slate-400">Loading shipments…</div> : null}
      <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="…or type tracking number(s), comma-separated"
        className="w-full text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 outline-none focus:ring-2 focus:ring-violet-400" />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional operator notes (as a rep would type them)"
        className="w-full text-sm rounded-lg ring-1 ring-slate-200 px-2 py-1.5 outline-none focus:ring-2 focus:ring-violet-400" />
      <button onClick={run} disabled={busy}
        className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40">
        <Eye className="h-4 w-4" /> {busy ? "Drafting… (up to a minute)" : "Preview email"}
      </button>
      {err ? <div className="text-sm text-rose-700">{err}</div> : null}
      {out ? (
        <div className="rounded-xl ring-1 ring-slate-200 overflow-hidden">
          <div className="bg-slate-50 px-3 py-2 text-xs text-slate-500 flex justify-between gap-2 flex-wrap">
            <span>{out.edited ? "With your unsaved edits" : "With the saved prompts"}</span>
            {out.model ? <span>{out.model}</span> : null}
          </div>
          <div className="px-3 py-2 border-b border-slate-100 text-sm"><span className="text-slate-500">Subject: </span><span className="font-medium">{out.subject}</span></div>
          <pre className="px-3 py-3 text-sm whitespace-pre-wrap font-sans text-slate-800">{out.body}</pre>
        </div>
      ) : null}
    </div>
  );
}
