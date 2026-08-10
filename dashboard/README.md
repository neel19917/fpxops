# FPXpress Dashboard

Vite + React + TypeScript + Tailwind v4 + Supabase Auth + lucide icons.

## Setup

```bash
cp .env.example .env.local
# fill in:
#   VITE_FPX_API_URL        — your Railway API URL
#   VITE_SUPABASE_URL       — Supabase project URL
#   VITE_SUPABASE_ANON_KEY  — Supabase anon key
npm install
npm run dev                  # http://localhost:5173
```

Sign in with Microsoft. First time through, you'll land on a "Pending approval"
page — an admin needs to flip your `enabled` flag in the **Users** tab.

## Pages

| Tab | Who sees it | What it does |
|---|---|---|
| Shipments | enabled users | Latest scrape per tracking_number (view), with drawer history + Share |
| AI Analyses | enabled users | Every Claude call with tokens, cost, duration |
| GP Audits | enabled users | GP runs + rows, shareable |
| Invoice Audits | enabled users | Invoice-bill matches, shareable |
| Share Links | enabled users | Your share links + view counts |
| Users | admins only | Enable/disable users, set role |
| API Keys | admins only | Mint keys for the extension/integrations |

## Deploy (Netlify)

1. Connect the GitHub repo in Netlify → **Base directory**: `dashboard`
2. Build command: `npm run build` · Publish directory: `dist`
3. **Environment variables** — all three are required, and must be set for
   every branch context you deploy (branch deploys don't inherit production
   scope). `src/lib/supabase.ts` throws on a dev build if the Supabase pair is
   missing and logs an error on a production build; there are no longer any
   hardcoded fallbacks silently covering for a typo.
   - `VITE_FPX_API_URL`        = your Railway URL
   - `VITE_SUPABASE_URL`       = Supabase project URL
   - `VITE_SUPABASE_ANON_KEY`  = Supabase anon key
4. After deploy, copy the Netlify URL (live site: `https://fpxpress.netlify.app`)
   and:
   - Add it to Railway's `CORS_ORIGINS` env var
   - In Supabase → Authentication → URL Configuration: add it under
     **Site URL** and **Redirect URLs**

   Keep that list tight — a stale origin left in **Redirect URLs** can receive
   an OAuth callback, which presents to the user as a session that vanishes
   immediately after sign-in.

### Microsoft OAuth (one-time)

Supabase handles the OAuth dance. In the Supabase dashboard:
1. **Authentication → Providers → Azure (Microsoft)** → enable
2. Paste your Azure AD Application (client) ID + client secret
3. Redirect URL template: `https://vvplkjgymahavqrejmgm.supabase.co/auth/v1/callback`
   (copy exact URL from the Supabase UI into your Azure app registration)
4. Limit who can sign in at the Azure AD side (e.g. single tenant) — or at the
   Supabase side via the allowlist, or by keeping `enabled=false` by default.

## Security posture

- **Everyone gets auto-provisioned disabled.** New Microsoft sign-ins land in
  `fpx_user_profiles` with `enabled = false`. Admins flip the flag.
- **All `fpx_*` tables have RLS.** Enabled users can SELECT via policies that
  check `fpx_is_enabled(auth.uid())`. Writes only via the Railway server
  using the service role.
- **Share links** never expose the API; the server fetches the resource and
  serves a sanitized view. Every view is logged to `fpx_share_link_views`.
- **Static site headers**: `noindex`, `DENY` iframes, no sensitive referrer.
