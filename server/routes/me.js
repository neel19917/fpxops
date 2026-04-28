import { Router } from "express";
import { requireAuth } from "../lib/auth.js";

export const meRouter = Router();

// GET /api/me — who am I? Lets the dashboard check enabled-status + role.
// Surfaces impersonation state so the dashboard can render the banner.
meRouter.get("/", requireAuth({ requireEnabled: false }), (req, res) => {
  if (req.user) {
    return res.json({
      kind: "user",
      user: req.user,
      realUser: req.realUser || req.user,
      impersonating: req.impersonating
        ? { mode: req.impersonating.mode, target: req.impersonating.target }
        : null,
    });
  }
  if (req.apiKey) {
    return res.json({
      kind: "api_key",
      apiKey: { id: req.apiKey.id, name: req.apiKey.name, scopes: req.apiKey.scopes },
    });
  }
  res.status(401).json({ error: "No identity" });
});
