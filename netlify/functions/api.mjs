import { getStore } from "@netlify/blobs";
import { handle } from "../lib/game.mjs";

export default async (req) => {
  const url = new URL(req.url);
  let body = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { body = {}; }
  }
  try {
    const demo = url.pathname.startsWith("/api/demo/");
    const store = getStore({ name: demo ? "escape-tower-demo" : "escape-tower", consistency: "strong" });
    const pin = demo ? "1234" : (Netlify.env.get("TEACHER_PIN") || "9876");
    const path = demo ? url.pathname.replace("/api/demo/", "/api/") : url.pathname;
    const { status, json } = await handle({ store, method: req.method, path, body, pin });
    return Response.json(json, { status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("api error", err);
    return Response.json({ ok: false, reason: "server", message: String(err && err.message || err) }, { status: 500, headers: { "cache-control": "no-store" } });
  }
};

export const config = { path: "/api/*" };
