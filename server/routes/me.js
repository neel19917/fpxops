import { Router } from "express";
import { requireAuth } from "../lib/auth.js";

export const meRouter = Router();

// GET /api/me — who am I? Lets the dashboard check enabled-status + role.
meRouter.get("/", requireAuth({ requireEnabled: false }), (req, res) => {
  if (req.user) {
    return res.json({
      kind: "user",
      user: req.user,
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
