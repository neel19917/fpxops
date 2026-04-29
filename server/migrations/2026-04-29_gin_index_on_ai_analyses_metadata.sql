-- The dashboard's group-email endpoints (carrier-email-drafts /
-- customer-email-drafts) and the bulk drafts panel filter
-- fpx_ai_analyses by JSON paths inside the metadata column:
-- subkind (email_draft_*), carrier, customer, user_email. Without an
-- index, those queries seq-scan the whole table — fine at hundreds of
-- rows today, slow once we hit 100k+.
--
-- jsonb_path_ops is the smallest, fastest GIN flavor for our access
-- pattern (we only query @> top-level key equality, never @? or @@
-- jsonpath traversal). Postgres uses this index for every
-- metadata @> '{...}'::jsonb lookup; the listGroupDrafts route
-- has been updated to use Supabase's .contains() helper which
-- compiles down to that form.

CREATE INDEX IF NOT EXISTS fpx_ai_analyses_metadata_gin_idx
  ON fpx_ai_analyses
  USING GIN (metadata jsonb_path_ops);
