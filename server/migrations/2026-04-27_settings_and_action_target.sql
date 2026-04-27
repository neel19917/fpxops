-- fpx_settings: admin-editable key/value store for prompts, model name, thresholds.
-- Values are JSONB so a setting can be a string, number, boolean, or object.
create table if not exists fpx_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

-- Seed default values. ON CONFLICT DO NOTHING so re-running the migration won't
-- clobber edits made through the dashboard.
insert into fpx_settings (key, value, description) values
  ('prompt.system',
   to_jsonb('You are a logistics analyst at FPX, a freight brokerage. FPX is the broker — the carrier hauls the freight, the customer is the shipper or consignee, and FPX manages the shipment between them. When you write a recommendation, the actor is FPX.'::text),
   'Base persona for all per-shipment Claude calls.'),
  ('prompt.per_shipment',
   to_jsonb($pps$Analyze the shipment data below and answer:
1. Is action required right now, and how confident are you (0.0–1.0)?
2. If action is needed, who is the action targeted at — the customer or the carrier?
3. What is the problem (one sentence)?
4. What should FPX do next (one to two sentences)?

Rules:
- Use plain English. No jargon the customer wouldn't understand.
- Base your answer ONLY on the data provided. Do not assume or invent information.
- The actor in the recommendation is always FPX (the broker).
- "actionConfidence" is your probability (0.0–1.0) that this shipment requires action right now.
- "actionTarget" must be one of: "customer", "carrier", "none". Use "none" only when no action is needed.

Respond in this exact JSON format:
{
  "actionConfidence": 0.0,
  "actionTarget": "customer" | "carrier" | "none",
  "issue": "One sentence describing the problem, or 'None - shipment is on track'",
  "recommendation": "One to two sentences on what FPX should do or communicate"
}

Shipment data:
{{data}}$pps$::text),
   'Per-shipment analysis prompt. Must return actionConfidence + actionTarget.'),
  ('prompt.priority',
   to_jsonb($pp$URGENT SHIPMENT REVIEW — This shipment has been flagged as critical.

Analyze the shipment data below carefully. Focus on:
1. What is the specific problem requiring immediate action?
2. What is the business impact if this is not addressed now?
3. What concrete steps should FPX take immediately?
4. Who must FPX contact first — the customer or the carrier?

Rules:
- Be specific and direct. This is a priority escalation.
- If there is a delay, exception, or missed appointment, state the exact issue.
- Base your answer ONLY on the data provided.

Respond in this exact JSON format:
{
  "actionConfidence": 0.0,
  "actionTarget": "customer" | "carrier" | "none",
  "issue": "One sentence describing the problem",
  "recommendation": "One to two sentences on immediate next steps"
}

Shipment data:
{{data}}$pp$::text),
   'Priority/escalation variant of the per-shipment prompt.'),
  ('prompt.summary',
   to_jsonb($ps$You are reviewing a summary of shipments FPX is brokering, scraped from the FreightPOP dashboard. FPX is the broker — write the summary FOR the FPX operations team.

The data includes aggregate counts and two lists: actionItems (shipments needing action) and sample (a sample of on-track shipments). Provide a brief executive summary:
- How many shipments need immediate action?
- What are the most common issues?
- Which shipments are top priority and why?
- Any patterns FPX should be aware of?

Use plain English. Be direct and actionable. Refer to FPX (us) — not "the broker".

Shipment summary:
{{allShipments}}$ps$::text),
   'Cross-shipment executive summary prompt.'),
  ('prompt.email_draft.system_base',
   to_jsonb($ped$You are a freight brokerage operations assistant at FPX. FPX is the freight broker — not the carrier and not the customer. You always write FROM FPX. Drafting an email now. {{audienceCopy}} Output strict JSON: {"subject": "...", "body": "..."}. Body should be plain text with line breaks ('\n') — no markdown. Sign as "[Your name]\nFPX Operations" (do not invent a name).$ped$::text),
   'System prompt for email drafts. {{audienceCopy}} is replaced with the carrier or customer paragraph.'),
  ('prompt.email_draft.audience_carrier',
   to_jsonb($pec$Write a concise, professional email FROM the FPX brokerage operations team TO the carrier handling this shipment. Ask for the specific information needed to resolve the issue or confirm status. Reference carrier-side identifiers (PRO, pickup number, carrier-issued tracking).$pec$::text),
   'Audience paragraph injected into the email-draft prompt when audience=carrier.'),
  ('prompt.email_draft.audience_customer',
   to_jsonb($peu$Write a concise, professional email FROM the FPX brokerage account team TO the end customer (the shipper or consignee, not the carrier). Update them on shipment status in plain English; avoid carrier jargon. If action is required from the customer, state it clearly. Otherwise reassure them FPX is monitoring and following up directly with the carrier.$peu$::text),
   'Audience paragraph injected into the email-draft prompt when audience=customer.'),
  ('action.threshold',
   to_jsonb(0.7),
   'Confidence threshold (0.0–1.0). Shipments with actionConfidence >= threshold get action_required=YES.'),
  ('action.auto_draft_enabled',
   to_jsonb(true),
   'When true, automatically generate an email draft for shipments crossing the action threshold, addressed to actionTarget.'),
  ('model.default',
   to_jsonb('claude-haiku-4-5-20251001'::text),
   'Default Anthropic model for short prompts.'),
  ('model.large',
   to_jsonb('claude-sonnet-4-6'::text),
   'Model used when prompt+message exceeds the large-prompt threshold (~12k chars).')
on conflict (key) do nothing;

-- Persist the AI-chosen action target on the shipment row so the UI can render
-- a "(customer)" / "(carrier)" badge and so auto-drafts can pick the audience.
alter table fpx_shipments
  add column if not exists action_target     text,
  add column if not exists action_confidence numeric(4,3);

create index if not exists fpx_shipments_action_target_idx
  on fpx_shipments (action_target)
  where action_target is not null;
