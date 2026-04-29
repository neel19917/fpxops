-- Retroactive prefix-tagging for tasks created before the
-- autoCreateActionTasks change that prepends "Carrier followup: " /
-- "Customer followup: " based on the shipment's action_target.
-- Without this backfill, existing AI-created tasks were stranded
-- in the generic Kanban and never surfaced in the new followup
-- panels. Idempotent: the WHERE clause excludes anything that
-- already contains "follow" in the title, so re-running won't
-- double-prefix.
--
-- Scope: active tasks only (open + in_progress). Done/cancelled
-- tasks are intentionally left untouched — they're history.

UPDATE fpx_shipment_tasks t
SET title = 'Carrier followup: ' || t.title
FROM fpx_shipments s
WHERE t.shipment_id = s.id
  AND t.status IN ('open', 'in_progress')
  AND LOWER(s.action_target) = 'carrier'
  AND LOWER(t.title) NOT LIKE '%follow%';

UPDATE fpx_shipment_tasks t
SET title = 'Customer followup: ' || t.title
FROM fpx_shipments s
WHERE t.shipment_id = s.id
  AND t.status IN ('open', 'in_progress')
  AND LOWER(s.action_target) = 'customer'
  AND LOWER(t.title) NOT LIKE '%follow%';
