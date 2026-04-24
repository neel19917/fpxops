// FPX API server (Railway). The extension no longer talks to Anthropic directly —
// all AI calls go through this server, which also writes to Supabase.
//
// Replace the URL below with your Railway deployment URL, and the key with an
// fpx_live_... key issued from the dashboard's API Keys tab (scopes: read, write).
const FPX_API_URL = "https://YOUR-APP.up.railway.app";
const FPX_API_KEY = "YOUR_FPX_API_KEY_HERE";
