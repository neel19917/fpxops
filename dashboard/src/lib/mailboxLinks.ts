import { apiUrl, getAccessTokenOrWait } from "./api";
import { impersonateHeaders } from "./impersonate";

// Cross-links from a shipment or a task to its Support Mailbox threads.
// Kept separate from mailboxApi.ts on purpose (types are defined here too).

export type LinkedThreadStatus = "awaiting_reply" | "responded" | "outbound_only";
export type LinkedThreadParty = "customer" | "carrier" | "internal" | "other" | "unknown";

export interface LinkedThread {
  conversation_id: string;
  subject: string | null;
  last_message_at: string | null;
  status: LinkedThreadStatus | string;
  party?: LinkedThreadParty | string | null;
  linked_shipment_ids?: string[] | null;
  message_count?: number | null;
  last_from_name?: string | null;
}

/** Thrown when the server doesn't have the linking routes yet (older deploy). */
export class MailboxLinksUnavailableError extends Error {
  constructor() {
    super("Emails will appear here once the mailbox update is live.");
    this.name = "MailboxLinksUnavailableError";
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = await getAccessTokenOrWait();
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/mailbox${path}`, {
      method: "GET",
      signal: signal ?? AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, ...impersonateHeaders() },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("The server took too long to answer. Try again.");
    throw e;
  }
  if (res.status === 404) throw new MailboxLinksUnavailableError();
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ? String(body.error) : `The server returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const getThreadsForShipment = (shipmentId: string, signal?: AbortSignal) =>
  get<{ threads: LinkedThread[] }>(`/by-shipment/${encodeURIComponent(shipmentId)}`, signal);

export const getThreadsForTask = (taskId: string, signal?: AbortSignal) =>
  get<{ shipment_id: string | null; threads: LinkedThread[] }>(`/by-task/${encodeURIComponent(taskId)}`, signal);

export const mailboxThreadHref = (conversationId: string) => `/mailbox?c=${encodeURIComponent(conversationId)}`;
export const mailboxShipmentHref = (shipmentId: string) => `/mailbox?shipment=${encodeURIComponent(shipmentId)}`;
