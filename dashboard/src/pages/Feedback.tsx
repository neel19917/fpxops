import { useEffect, useState } from "react";
import { MessageSquare, Send, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { Feedback, FeedbackCategory, FeedbackStatus } from "../lib/types";
import { LoadingState } from "../components/LoadingState";

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Bug",
  feature: "Feature request",
  support: "Support",
  other: "Other",
};

const STATUS_COLOR: Record<FeedbackStatus, string> = {
  open: "bg-sky-100 text-sky-700",
  triaged: "bg-violet-100 text-violet-700",
  in_progress: "bg-amber-100 text-amber-700",
  resolved: "bg-emerald-100 text-emerald-700",
  wont_fix: "bg-slate-200 text-slate-600",
};

export function FeedbackPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [items, setItems] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Submission form state
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.feedback.list();
      setItems(r.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      await api.feedback.create({
        category, title: title.trim(), body: body.trim(), source: "dashboard",
        context: { url: window.location.href, userAgent: navigator.userAgent },
      });
      setTitle(""); setBody(""); setCategory("bug");
      setJustSubmitted(true);
      setTimeout(() => setJustSubmitted(false), 2500);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setSubmitting(false); }
  }

  async function setStatus(f: Feedback, status: FeedbackStatus) {
    try {
      const { feedback } = await api.feedback.update(f.id, { status });
      setItems((prev) => prev.map((p) => (p.id === feedback.id ? feedback : p)));
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-6">
      <div>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2"><MessageSquare className="h-6 w-6 text-slate-700" /> Feedback</h1>
            <p className="text-sm text-slate-500 mt-0.5">{isAdmin ? "All user feedback. Triage, resolve, or close." : "Your submitted feedback."}</p>
          </div>
          <button onClick={load} className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 flex items-center gap-1.5">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>

        {error ? <div className="mb-4 rounded-lg bg-red-50 text-red-700 px-4 py-2 text-sm">{error}</div> : null}

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {loading ? (
            <LoadingState />
          ) : items.length === 0 ? (
            <div className="text-center text-slate-400 py-8">No feedback yet.</div>
          ) : (
            <ul>
              {items.map((f) => (
                <li key={f.id} className="border-t first:border-t-0 border-slate-100 px-5 py-4 hover:bg-slate-50/60">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-slate-500 uppercase">{CATEGORY_LABELS[f.category]}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[f.status]}`}>{f.status.replace("_", " ")}</span>
                        {f.severity !== "normal" ? <span className="text-xs text-amber-700">[{f.severity}]</span> : null}
                      </div>
                      <div className="mt-1 font-semibold text-slate-900">{f.title}</div>
                      <p className="mt-1 text-sm text-slate-600 whitespace-pre-wrap">{f.body}</p>
                      <div className="mt-2 text-xs text-slate-400">
                        {f.user_email || "(unknown)"} · {new Date(f.created_at).toLocaleString()}
                      </div>
                    </div>
                    {isAdmin ? (
                      <select
                        value={f.status}
                        onChange={(e) => setStatus(f, e.target.value as FeedbackStatus)}
                        className="text-xs rounded-md border border-slate-200 px-2 py-1 bg-white"
                      >
                        <option value="open">open</option>
                        <option value="triaged">triaged</option>
                        <option value="in_progress">in progress</option>
                        <option value="resolved">resolved</option>
                        <option value="wont_fix">won't fix</option>
                      </select>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <aside className="bg-white border border-slate-200 rounded-xl p-5 h-fit">
        <h2 className="text-sm font-semibold mb-3">Send feedback</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
            >
              <option value="bug">Bug</option>
              <option value="feature">Feature request</option>
              <option value="support">Support</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              placeholder="Short summary"
              maxLength={140}
              required
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">Details</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm h-32"
              placeholder="What happened? Steps to reproduce, expected vs actual, etc."
              required
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !title.trim() || !body.trim()}
            className="w-full rounded-lg bg-slate-900 text-white text-sm px-3 py-2 flex items-center justify-center gap-1.5 hover:bg-slate-800 disabled:opacity-50"
          >
            <Send className="h-4 w-4" /> {submitting ? "Sending…" : "Send"}
          </button>
          {justSubmitted ? <div className="text-xs text-emerald-700 text-center">Thanks — we got it.</div> : null}
        </form>
      </aside>
    </div>
  );
}
