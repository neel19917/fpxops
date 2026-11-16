-- Reps rate AI generations with thumbs up / down so the team can
-- iterate on prompts. Schema is intentionally minimal — three columns
-- on the existing fpx_ai_analyses table, no separate table.
-- rating: NULL = unrated, 'up' = thumbs up, 'down' = thumbs down.
-- rating_reason: optional free-text the rep can leave (esp. on down).
-- rated_by: who rated it (email from auth context, or api key name).
-- rated_at: timestamptz so we can chart rating velocity later.

ALTER TABLE fpx_ai_analyses
  ADD COLUMN IF NOT EXISTS rating TEXT
    CHECK (rating IS NULL OR rating IN ('up', 'down')),
  ADD COLUMN IF NOT EXISTS rating_reason TEXT,
  ADD COLUMN IF NOT EXISTS rated_by TEXT,
  ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;

-- Index on (rating, created_at) so rolling up "down-rated drafts in
-- the last week" stays fast even as the analyses table grows.
CREATE INDEX IF NOT EXISTS fpx_ai_analyses_rating_idx
  ON fpx_ai_analyses (rating, created_at DESC)
  WHERE rating IS NOT NULL;
