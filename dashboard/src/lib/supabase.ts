import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://vvplkjgymahavqrejmgm.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2cGxramd5bWFoYXZxcmVqbWdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTMxMzQ0MTUsImV4cCI6MjA2ODcxMDQxNX0.doQ5BUgcJzuCjSOUNeo-as50C41cHC3up-xlRY-dF0M";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export type { Session };
