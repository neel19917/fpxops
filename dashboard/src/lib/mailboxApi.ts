import { apiUrl, getAccessTokenOrWait } from "./api";
import { impersonateHeaders } from "./impersonate";

// Client calls for the Support Mailbox (/mailbox) and its admin connect page
// (/admin/support-mailbox). From /api/mailbox. FPX never sends mail: the only
// Outlook write is creating a reply DRAFT, which a person sends from Outlook.

export const DEFAULT_MAILBOX = "freightsupport@freightpop.com";

export type ThreadStatus = "awaiting_reply" | "responded" | "outbound_only";
export type ThreadFilter = "all" | ThreadStatus;
export type ConnectionStatus = "connected" | "error" | "disconnected";
/** Who a conversation is with. "unknown" until the linker classifies it. */
export type Party = "customer" | "carrier" | "internal" | "other" | "unknown";
export type PartyFilter = "all" | Party;
/** The list's time range, in days ("all" = all time). Default 30. */
export type RangeDays = "7" | "30" | "90" | "all";
export type PartySource = "rule" | "ai" | "person";

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
  /** From the linker; absent on a server that has not been updated yet. */
  party?: Party | null;
  linked_shipment_ids?: string[] | null;
  linked_count?: number | null;
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
  /** The signed-in user's mailbox access (admins always "draft"). Absent on an older server. */
  access?: MailboxAccess;
}

/** Per-user Support Mailbox access. "view" reads only; "draft" can also write. */
export type MailboxAccess = "none" | "view" | "draft";

/** A mailbox call the server refused (403): the message is the server's own. */
export class MailboxForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "MailboxForbiddenError";
  }
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

export interface ThreadLink {
  id: string;
  connection_id?: string | null;
  conversation_id: string;
  shipment_id: string;
  matched_on: string | null;
  matched_text: string | null;
  source: "auto" | "person" | string | null;
  created_by?: string | null;
  dismissed: boolean;
  dismissed_by?: string | null;
  dismissed_at?: string | null;
  created_at?: string | null;
}

export interface ContextShipment {
  shipment_id: string;
  tracking_number: string | null;
  customer_name: string | null;
  carrier_name: string | null;
  mode: string | null;
  shipment_status: string | null;
  pickup_date: string | null;
  estimated_arrival: string | null;
  delivery_date: string | null;
  origin: string | null;
  destination: string | null;
  matched_on: string | null;
  matched_text: string | null;
  source: string | null;
  link_id: string;
  /** When the link was logged as a note on the FPX shipment (null = not logged; missing on older servers). */
  logged_at?: string | null;
  /** The fpx_shipment_notes row written for the log. */
  note_id?: string | null;
  /** fpx_shipments.id (uuid) of the linked shipment. */
  fpx_id?: string | null;
}

/** A shipment-looking number found in the emails that does not match any FPX shipment. */
export interface NotInFpx {
  value: string;
  kind: string;
}

export interface ContextTask {
  id: string;
  shipment_id: string;
  title: string | null;
  status: string | null;
  priority: string | null;
  assigned_to: string | null;
  due_at: string | null;
  created_at: string | null;
}

export interface RelatedThread {
  conversation_id: string;
  subject: string | null;
  last_message_at: string | null;
  status: ThreadStatus;
  party: Party | null;
}

export interface ThreadContext {
  party: { party: Party; source: PartySource | null; reason: string | null; set_by: string | null };
  sender_domains: { domain: string; party: Exclude<Party, "unknown"> | null }[];
  shipments: ContextShipment[];
  tasks: ContextTask[];
  related_threads: RelatedThread[];
  /** Missing on older servers: treat as []. */
  not_in_fpx?: NotInFpx[];
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
    if (res.status === 403) throw new MailboxForbiddenError(body?.error ? String(body.error) : "You don't have access to do that in the Support Mailbox.");
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
  opts: {
    status?: ThreadFilter; q?: string; limit?: number; offset?: number;
    party?: PartyFilter; days?: RangeDays; shipment_id?: string;
  } = {},
  signal?: AbortSignal,
) =>
  call<ThreadList>("/threads", {
    params: {
      status: opts.status || "all",
      q: opts.q?.trim() || undefined,
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
      party: opts.party && opts.party !== "all" ? opts.party : undefined,
      days: opts.days || "30",
      shipment_id: opts.shipment_id?.trim() || undefined,
    },
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

// ---- Linking: party, shipments, tasks, related threads (any signed-in user) ----

/** Party, linked shipments and their tasks, and related threads for the sidebar. */
export const getThreadContext = (conversationId: string, signal?: AbortSignal) =>
  call<ThreadContext>(`/threads/${enc(conversationId)}/context`, { signal });

/** Link a shipment by hand. The shipment must exist in FPX. */
export const linkShipment = (conversationId: string, shipmentId: string) =>
  call<{ link: ThreadLink }>(`/threads/${enc(conversationId)}/links`, { body: { shipment_id: shipmentId.trim() } });

/** Hides a link (it is flagged, never deleted). */
export const dismissLink = (linkId: string) =>
  call<{ link: ThreadLink }>(`/links/${enc(linkId)}/dismiss`, { body: {} });

export const setThreadParty = (conversationId: string, party: Exclude<Party, "unknown">) =>
  call<{ party: unknown }>(`/threads/${enc(conversationId)}/party`, { method: "PUT", body: { party } });

/** Treat every email from this domain as the party (re-classifies its threads). */
export const setDomainParty = (domain: string, party: Exclude<Party, "unknown">) =>
  call<{ domain: unknown }>(`/domains/${enc(domain)}`, { method: "PUT", body: { party } });
