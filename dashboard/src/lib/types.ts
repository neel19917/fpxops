export type ActionStatus = "YES" | "NO" | "ERROR" | null | string;

export interface Shipment {
  id: string;
  tracking_number: string | null;
  shipment_id: string | null;
  customer_name: string | null;
  customer_id: string | null;
  account_manager: string | null;
  carrier: string | null;
  carrier_name: string | null;
  mode: string | null;
  shipment_status: string | null;
  comments: string | null;
  pickup_response: string | null;
  pickup_date: string | null;
  updated_eta: string | null;
  estimated_departure: string | null;
  actual_departure: string | null;
  estimated_arrival: string | null;
  actual_arrival: string | null;
  delivery_date: string | null;
  signed_by: string | null;
  origin: string | null;
  destination: string | null;
  ship_from: string | null;
  ship_to: string | null;
  shipment_marked_up_rate: number | null;
  shipment_rate_without_markup: number | null;
  shipment_gross_profit: number | null;
  action_required: ActionStatus;
  ai_issue: string | null;
  ai_recommendation: string | null;
  raw_data: unknown;
  scraped_at: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  seen_count: number;
  action_source: "ai" | "manual" | "none";
  action_overridden_by: string | null;
  action_overridden_at: string | null;
  action_override_reason: string | null;
  // FreightPOP grid parity (added 2026-04 — may be null on shipments scraped before the column rollout)
  company_name: string | null;
  shipment_date: string | null;
  tracking_comments: string | null;
  shipper_spot_quote: string | null;
  pickup_tendered: string | null;
  last_modified_at: string | null;
  updated_via: string | null;
  original_eta: string | null;
  order_number: string | null;
  reference_one: string | null;
  reference_two: string | null;
  reference_three: string | null;
  reference_four: string | null;
  reference_five: string | null;
  reference_six: string | null;
  ready_time: string | null;
  cut_off_time: string | null;
  appointment_set: boolean | null;
  appointment_date: string | null;
  required_arrival_date: string | null;
  spot_quote_fulfilled_by: string | null;
  // Free-form operator notes (drawer-only).
  notes: string | null;
  // Most recent timestamp at which the bulk-upsert flow saw a non-
  // empty material diff vs the prior scrape. Drives the "just
  // changed" pill on the Tracking table — null = never changed
  // since we started tracking, or first-ever scrape.
  last_material_change_at: string | null;
  // Pre-existing optional fields used by some columns
  service: string | null;
  pickup_request_number: string | null;
  confirmation_number: string | null;
  total_weight: number | null;
  total_packages: number | null;
}

export interface AuditLogEntry {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  actor_source: "jwt" | "api_key" | "system" | null;
  api_key_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export type AnalysisKind = "per_shipment" | "summary" | "gp_audit" | "invoice_audit" | "other";

export interface AiAnalysis {
  id: string;
  kind: AnalysisKind;
  shipment_uuid: string | null;
  tracking_number: string | null;
  gp_audit_id: string | null;
  invoice_audit_id: string | null;
  model: string | null;
  system_prompt: string | null;
  user_message: string | null;
  response_text: string | null;
  action_required: string | null;
  issue: string | null;
  recommendation: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  source: string | null;
  user_email: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  // Rep-supplied prompt-quality rating. Null = unrated. Set via the
  // 👍 / 👎 buttons on analysis cards / draft cards.
  rating?: "up" | "down" | null;
  rating_reason?: string | null;
  rated_by?: string | null;
  rated_at?: string | null;
}

export interface GpAudit {
  id: string;
  run_by: string | null;
  date_from: string | null;
  date_to: string | null;
  shipment_type: string | null;
  total_rows: number | null;
  outlier_count: number | null;
  mean_gp_pct: number | null;
  stdev_gp_pct: number | null;
  exec_summary: string | null;
  created_at: string;
}

export interface GpAuditRow {
  id: string;
  audit_id: string;
  shipment_id: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  gross_profit: number | null;
  gp_pct: number | null;
  is_outlier: boolean;
  std_deviations: number | null;
  ai_notes: string | null;
}

export interface InvoiceAudit {
  id: string;
  run_by: string | null;
  date_from: string | null;
  date_to: string | null;
  total_rows: number | null;
  match_count: number | null;
  discrepancy_count: number | null;
  unmatched_count: number | null;
  exec_summary: string | null;
  created_at: string;
}

export interface InvoiceAuditRow {
  id: string;
  audit_id: string;
  shipment_id: string | null;
  carrier: string | null;
  bill_amount: number | null;
  shipment_cost: number | null;
  difference: number | null;
  status: string | null;
  ai_notes: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface UserProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: "viewer" | "member" | "admin";
  enabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface ShareLink {
  id: string;
  token: string;
  resource_type: "shipment" | "gp_audit" | "invoice_audit" | "analysis";
  resource_id: string;
  label: string | null;
  created_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
}

export interface ShareLinkView {
  id: string;
  link_id: string;
  viewed_at: string;
  viewer_ip: string | null;
  viewer_user_agent: string | null;
  viewer_user_id: string | null;
  referrer: string | null;
}

export type TaskStatus = "open" | "in_progress" | "done" | "blocked" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface ShipmentTask {
  id: string;
  shipment_id: string;
  // FreightPOP-side shipment id (e.g. "13583467"), pulled by the
  // /api/tasks list route from the joined shipment row. Null if the
  // shipment has no external id yet (legacy rows pre-backfill, or the
  // shipment was deleted). The task's own shipment_id column above is
  // the internal UUID FK — different value, different purpose.
  shipment_external_id?: string | null;
  tracking_number: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  created_by: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Slim per-shipment shape returned by /api/tasks/carrier-followups. Curated
// subset of Shipment that the carrier-followups panel + email modal need —
// keeping it narrow keeps the JSON payload small for what is otherwise a
// hot path on the Tasks page.
export interface CarrierFollowupShipment {
  id: string;
  tracking_number: string | null;
  shipment_id: string | null;
  customer_name: string | null;
  carrier: string | null;
  carrier_name: string | null;
  mode: string | null;
  shipment_status: string | null;
  pickup_date: string | null;
  updated_eta: string | null;
  estimated_arrival: string | null;
  delivery_date: string | null;
  origin: string | null;
  destination: string | null;
  ship_from: string | null;
  ship_to: string | null;
  ai_issue: string | null;
  ai_recommendation: string | null;
  action_required: ActionStatus;
}

export type FeedbackCategory = "bug" | "feature" | "support" | "other";
export type FeedbackStatus = "open" | "triaged" | "in_progress" | "resolved" | "wont_fix";
export type FeedbackSeverity = "low" | "normal" | "high" | "urgent";

export interface Feedback {
  id: string;
  user_id: string | null;
  user_email: string | null;
  category: FeedbackCategory;
  title: string;
  body: string;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  source: string | null;
  context: Record<string, unknown> | null;
  admin_notes: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailDraft {
  subject: string;
  body: string;
  raw?: string;
}
