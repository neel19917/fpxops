-- Per-user API key issuance flow:
--   admin clicks "Issue API key" → server generates key, hashes it into
--   fpx_api_keys, stashes the plaintext in fpx_user_profiles.pending_api_key
--   with a 24h expiry. The rep's extension calls /api/me, gets the plaintext
--   back, saves it locally, and the server clears the stash on delivery.

alter table public.fpx_user_profiles
  add column if not exists pending_api_key text,
  add column if not exists pending_api_key_expires_at timestamptz;

-- Tie API keys back to the user profile so we can list a user's active keys
-- and avoid duplicate-issuance.
alter table public.fpx_api_keys
  add column if not exists user_id uuid references public.fpx_user_profiles(id) on delete set null;

create index if not exists fpx_api_keys_user_id_idx
  on public.fpx_api_keys(user_id) where revoked_at is null;
