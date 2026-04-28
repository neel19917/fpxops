// Pure decision logic for the auto-issued API key delivery flow.
//
// The /api/me handler reads fpx_user_profiles for the calling user, hands the
// row to decidePendingApiKey(), and follows the verdict:
//   - plaintext != null → return it in the response so the extension can
//     stash it as the local fpxApiKey
//   - shouldClear === true → null out pending_api_key + expires_at on the
//     row so we never re-deliver and never leave a stale secret behind
//
// The "always clear on any read" rule means an expired stash is wiped on
// the first /api/me after expiry — the rep just doesn't get the plaintext
// (admin re-issues if needed). One-shot, never persistent.
export function decidePendingApiKey(row, nowMs = Date.now()) {
  const out = { plaintext: null, shouldClear: false };
  if (!row || !row.pending_api_key) return out;
  out.shouldClear = true;
  const exp = row.pending_api_key_expires_at ? Date.parse(row.pending_api_key_expires_at) : 0;
  if (Number.isFinite(exp) && exp > nowMs) {
    out.plaintext = row.pending_api_key;
  }
  return out;
}
