import { callClaude } from "../anthropic.js";
import { getSettings } from "../settings.js";
import { emailModelExtras } from "../emailDraft.js";

// AI reply drafting for the Support Mailbox (freightsupport@freightpop.com).
// Writes text only — it never touches Outlook. The route turns the text into
// an Outlook draft only when a person asks it to (POST .../draft).

export const SIGNATURE = "FreightPOP Support";
export const MAX_PROMPT_CHARS = 30_000;
const MAX_REPLY_BODY_CHARS = 15_000;
const MAX_INSTRUCTIONS_CHARS = 2_000;

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

// HTML email body -> readable plain text. Good enough for a prompt; not a
// general-purpose sanitizer.
export function htmlToText(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k.startsWith("#x")) { const n = parseInt(k.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    if (k.startsWith("#")) { const n = parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return m;
  });
  s = s.replace(/\r/g, "").replace(/[ \t ]+\n/g, "\n").replace(/[ \t ]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Drop the quoted history Outlook / Gmail append below a reply, so the
// message being answered is only what that person wrote. The earlier
// messages are already in the prompt from the thread.
export function stripQuotedHistory(text) {
  const s = String(text || "");
  const markers = [
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{5,}\s*\n\s*From:/i,
    /\nFrom:\s.*\n(?:.*\n){0,2}?Sent:\s/i,
    /\nOn .{4,200}wrote:\s*\n/i,
  ];
  let cut = s.length;
  for (const re of markers) {
    const m = re.exec(s);
    if (m && m.index > 0 && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut).trim();
}

function fmtWho(name, address) {
  if (name && address) return `${name} <${address}>`;
  return name || address || "(unknown)";
}

function fmtRecipients(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list.map((r) => {
    const ea = r?.emailAddress || r || {};
    return fmtWho(ea.name, ea.address);
  }).join(", ");
}

function msgDate(m) {
  return m?.received_at || m?.sent_at || null;
}

// Build the user message for the drafting model. Thread messages come oldest
// first (body previews); the message being answered gets its full text. Over
// budget, the oldest previews are dropped first.
export function buildMailboxDraftPrompt({ messages = [], replyTo, replyBodyText = "", instructions = "", mailbox = "freightsupport@freightpop.com" } = {}) {
  const sorted = [...messages].sort((a, b) => String(msgDate(a) || "").localeCompare(String(msgDate(b) || "")));
  const blocks = sorted.map((m, i) => {
    const who = m.direction === "out" ? `${fmtWho(m.from_name, m.from_address)} (FreightPOP Support)` : fmtWho(m.from_name, m.from_address);
    const to = fmtRecipients(m.to_recipients);
    return [
      `[${i + 1}] ${m.direction === "out" ? "SENT BY SUPPORT" : "RECEIVED"} ${msgDate(m) || ""}`.trim(),
      `From: ${who}`,
      to ? `To: ${to}` : null,
      m.subject ? `Subject: ${m.subject}` : null,
      String(m.body_preview || "").trim() || "(no preview)",
    ].filter(Boolean).join("\n");
  });

  const replyFull = String(replyBodyText || "").trim().slice(0, MAX_REPLY_BODY_CHARS) || String(replyTo?.body_preview || "").trim();
  const replySection = [
    "<message_to_reply_to>",
    `From: ${fmtWho(replyTo?.from_name, replyTo?.from_address)}`,
    replyTo?.subject ? `Subject: ${replyTo.subject}` : null,
    msgDate(replyTo) ? `Date: ${msgDate(replyTo)}` : null,
    "",
    replyFull || "(empty)",
    "</message_to_reply_to>",
  ].filter((x) => x !== null).join("\n");

  const instr = String(instructions || "").trim().slice(0, MAX_INSTRUCTIONS_CHARS);
  const instrSection = instr ? `<agent_instructions>\n${instr}\n</agent_instructions>\nFollow the support agent's instructions above.\n\n` : "";
  const head = `Support inbox: ${mailbox}\n\n`;
  const tail = `\n\n${replySection}\n\n${instrSection}Write the reply to the message above now. Plain-text body only, signed "${SIGNATURE}".`;

  const budget = Math.max(0, MAX_PROMPT_CHARS - head.length - tail.length - 60);
  const kept = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const len = blocks[i].length + 2;
    if (used + len > budget) break;
    kept.unshift(blocks[i]);
    used += len;
  }
  const omitted = blocks.length - kept.length;
  const thread = `<thread oldest_first="true" messages="${blocks.length}">\n` +
    (omitted ? `(${omitted} older message(s) omitted for length)\n\n` : "") +
    kept.join("\n\n") + "\n</thread>";
  return (head + thread + tail).slice(0, MAX_PROMPT_CHARS + 200);
}

// Clean the model's text into a plain reply body that ends with the support
// signature.
export function finalizeReply(text) {
  let out = String(text || "").trim()
    .replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  out = out.replace(/^subject:.*\n+/i, "").trim();
  if (!out) return "";
  if (!out.includes(SIGNATURE)) out = `${out}\n\nBest regards,\n${SIGNATURE}`;
  return out;
}

// Generate a reply. Returns { body, model, analysis_id } or { error }.
export async function generateMailboxReply({ messages, replyTo, replyBodyHtml, instructions, mailbox, callMeta } = {}) {
  const settings = await getSettings("prompt.mailbox_draft.system", "prompt.mailbox_draft.model");
  const systemPrompt = String(settings["prompt.mailbox_draft.system"] || "");
  const model = settings["prompt.mailbox_draft.model"] || undefined;
  const replyBodyText = stripQuotedHistory(htmlToText(replyBodyHtml || ""));
  const userMessage = buildMailboxDraftPrompt({ messages, replyTo, replyBodyText, instructions, mailbox });
  const extras = emailModelExtras(model);
  const result = await callClaude({
    systemPrompt,
    userMessage,
    maxTokens: extras ? 4000 : 1200,
    modelOverride: model,
    extraBody: extras,
    metadata: {
      kind: "other",
      ...(callMeta || {}),
      metadata: { subkind: "mailbox_draft", ...((callMeta && callMeta.metadata) || {}) },
    },
  });
  if (result.error) return { error: result.error };
  const body = finalizeReply(result.text);
  if (!body) return { error: "Claude returned an empty reply" };
  return { body, model: result.model || model || null, analysis_id: result.analysis_id || null, stop_reason: result.stop_reason || null };
}
