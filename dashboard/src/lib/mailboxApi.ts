import { apiUrl, getAccessTokenOrWait } from "./api";
import { impersonateHeaders } from "./impersonate";

// Client calls for the Support Mailbox (/mailbox) and its admin connect page
// (/admin/support-mailbox). From /api/mailbox. FPX never sends mail: the only
// Outlook write is creating a reply DRAFT, which a person sends from Outlook.

export const DEFAULT_MAILBOX = "freightsupport@freightpop.com";

export type ThreadStatus = "awaiting_reply" | "responded" | "outbound_only";
export type ThreadFilter = "all" | ThreadStatus;
export type ConnectionStatus = "connected" | "error" | "disconnected";

export interface Recipient {
  emailAddress?: { name?: string | null; address?: string | null } | null;
  name?: string | null;
  address?: string | null;
}

export interface Thread {
  conversation_id: string;
  subject: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  message_count: number;
  preview: string | null;
  last_from_name: string | null;
  last_from_address: string | null;
  participants: string[] | null;
  status: ThreadStatus;
}

export interface Message {
  id: string;
  conversation_id: string | null;
  folder: "inbox" | "sentitems" | string;
  direction: "in" | "out";
  subject: string | null;
  from_address: string | null;
  from_name: string | null;
  to_recipients: Recipient[] | null;
  cc_recipients: Recipient[] | null;
  received_at: string | null;
  sent_at: string | null;
  body_preview: string | null;
  has_attachments: boolean | null;
  is_read: boolean | null;
  web_link: string | null;
}

export interface Draft {
  id: string;
  conversation_id: string | null;
  reply_to_message_id: string | null;
  web_link: string | null;
  body: string | null;
  ai_generated: boolean | null;
  reply_all: boolean | null;
  created_by: string | null;
  created_at: string;
}

/** The saved connection as the server shows it to the browser (no secret). */
export interface Connection {
  id: string;
  mailbox: string;
  tenant_id: string;
  client_id: string;
  secret_hint: string | null;
  status: ConnectionStatus;
  last_error: string | null;
  connected_by: string | null;
  connected_at: string | null;
  last_sync_at: string | null;
  last_sync_result: Record<string, unknown> | null;
  backfill_done: boolean;
  delta_links?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Status {
  connected: boolean;
  mailbox: string | null;
  status: ConnectionStatus | null;
  last_sync_at: string | null;
  backfill_done: boolean;
  message_count: number;
  last_error: string | null;
}

export type ConnectionTest =
  | { ok: true; inbox_total: number; sent_total: number }
  | { ok: false; error: string };

export interface ThreadCounts {
  all: number;
  awaiting_reply: number;
  responded: number;
  outbound_only: number;
}

export interface ThreadList {
  threads: Thread[];
  total: number;
  counts: ThreadCounts;
}

export interface ThreadDetail {
  thread: Thread;
  messages: Message[];
  drafts: Draft[];
}

export interface ConnectInput {
  tenant_id: string;
  client_id: string;
  client_secret: string;
  mailbox?: string;
}

const TIMEOUT_MS = 20_000;
/** AI drafting and Outlook writes can take a while. */
const SLOW_TIMEOUT_MS = 90_000;

async function call<T>(
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string | number | undefined>; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.params || {})) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  const q = search.toString();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const token = await getAccessTokenOrWait();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/mailbox${path}${q ? `?${q}` : ""}`, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...impersonateHeaders(),
      },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw e;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body?.error) throw new Error(String(body.error));
    throw new Error(res.status === 404 ? "The server does not have the mailbox yet. It needs its next update." : `The server returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;

// ---- Status (any user) ----
export const getMailboxStatus = (signal?: AbortSignal) => call<Status>("/status", { signal });

// ---- Connection (admin) ----
export const getMailboxConnection = (signal?: AbortSignal) =>
  call<{ connection: Connection | null }>("/connection", { signal });

export const connectMailbox = (input: ConnectInput) =>
  call<{ connection: Connection; test: ConnectionTest }>("/connection", {
    body: { ...input, mailbox: input.mailbox?.trim() || DEFAULT_MAILBOX },
    timeoutMs: SLOW_TIMEOUT_MS,
  });

export const testMailboxConnection = () =>
  call<{ test: ConnectionTest }>("/connection/test", { body: {}, timeoutMs: SLOW_TIMEOUT_MS });

export const disconnectMailbox = () =>
  call<{ connection: Connection }>("/connection/disconnect", { body: {} });

export const syncMailboxNow = () => call<{ started: boolean }>("/sync", { body: {} });

// ---- Threads and messages (any user) ----
export const listThreads = (
  opts: { status?: ThreadFilter; q?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) =>
  call<ThreadList>("/threads", {
    params: { status: opts.status || "all", q: opts.q?.trim() || undefined, limit: opts.limit ?? 50, offset: opts.offset ?? 0 },
    signal,
  });

export const getThread = (conversationId: string, signal?: AbortSignal) =>
  call<ThreadDetail>(`/threads/${enc(conversationId)}`, { signal });

export const getMessageBody = (messageId: string, signal?: AbortSignal) =>
  call<{ body_html: string }>(`/messages/${enc(messageId)}/body`, { signal, timeoutMs: SLOW_TIMEOUT_MS });

/** Claude writes a reply for the message. Nothing is written to Outlook. */
export const aiDraft = (messageId: string, instructions?: string) =>
  call<{ body: string }>(`/messages/${enc(messageId)}/ai-draft`, {
    body: { instructions: instructions?.trim() || undefined },
    timeoutMs: SLOW_TIMEOUT_MS,
  });

/** Creates a reply DRAFT in the mailbox's Outlook Drafts folder. Never sends. */
export const createDraft = (messageId: string, input: { body: string; reply_all?: boolean; ai_generated?: boolean }) =>
  call<{ draft: Draft }>(`/messages/${enc(messageId)}/draft`, { body: input, timeoutMs: SLOW_TIMEOUT_MS });
