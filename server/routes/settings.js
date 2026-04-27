import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { getAllSettingsForAdmin, setSetting, invalidateSettingsCache } from "../lib/settings.js";
import { logAudit } from "../lib/audit.js";
import { sendCachedJson } from "../lib/httpCache.js";

export const settingsRouter = Router();

// All settings routes require admin role (JWT) or admin scope (API key).
settingsRouter.use(requireAuth({ scope: "admin", role: "admin" }));

// GET /api/settings — return every editable setting, merged with defaults.
settingsRouter.get("/", async (req, res) => {
  try {
    const list = await getAllSettingsForAdmin();
    sendCachedJson(req, res, { data: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/settings/:key  body: { value }
// Value can be a string, number, boolean, or object — anything JSON-serializable.
settingsRouter.put("/:key", async (req, res) => {
  const key = String(req.params.key || "").trim();
  if (!key) return res.status(400).json({ error: "key required" });
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, "value")) {
    return res.status(400).json({ error: "body.value required" });
  }
  const value = req.body.value;
  const updatedBy = req.user?.email || req.apiKey?.name || "unknown";
  try {
    const row = await setSetting(key, value, updatedBy);
    logAudit(req, {
      action: "update",
      entity_type: "setting",
      entity_id: key,
      summary: `Updated setting ${key}`,
      after: { key, value },
      metadata: { key },
    });
    res.json({ setting: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/settings/refresh — force the in-process cache to drop. Admin-only;
// useful after editing rows directly in Supabase.
settingsRouter.post("/refresh", async (_req, res) => {
  invalidateSettingsCache();
  res.json({ ok: true });
});
