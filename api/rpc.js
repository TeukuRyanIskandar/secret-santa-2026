// Vercel serverless function: POST /api/rpc  { token, action, ...args }
import { makeCore, AppError } from "../lib/core.js";
import { supabaseStore } from "../lib/store-supabase.js";

let core;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  try {
    core ??= makeCore(supabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY), {
      setupKey: process.env.SETUP_KEY,
    });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    return res.status(200).json(await core.handle(body));
  } catch (e) {
    if (e instanceof AppError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: "Something went wrong on the server. Try again in a moment." });
  }
}
