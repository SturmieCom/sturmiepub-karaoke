// Song-request queue for Sturmie.pub Karaoke.
//   GET  /api/queue                      -> { open, items:[{id,name,artist,title,vendor,ts,status}] }
//   POST /api/queue {action:"request", name, artist, title, vendor}       (anyone, rate-limited)
//   POST /api/queue {action:"up"|"done"|"remove"|"move"|"clear"|"setOpen", ...}
//        with header  X-KJ-Password: <KJ_PASSWORD env var>                (KJ only)
// Each request is its own blob (q/<sortable id>), so two people requesting at once can't
// overwrite each other. CORS is open so the offline site on the KJ laptop can read the queue.
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_WAITING = 60;            // most songs that can wait in the queue
const PER_PERSON_SECONDS = 180;    // one request per device every 3 minutes
const MAX_PER_NAME = 2;            // a singer can have at most 2 songs waiting

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-kj-password",
  "access-control-max-age": "86400",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const store = () => getStore({ name: "karaoke-queue", consistency: "strong" });

async function readSettings(s) {
  return (await s.get("settings", { type: "json" })) || { open: true };
}

async function readQueue(s) {
  const { blobs } = await s.list({ prefix: "q/" });
  const items = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
  // singing now first, then waiting songs by position (order) then arrival time
  return items.sort((a, b) =>
    (a.status === "up" ? 0 : 1) - (b.status === "up" ? 0 : 1) ||
    (a.order ?? a.ts) - (b.order ?? b.ts) || a.ts - b.ts);
}

function isKJ(req) {
  const want = Netlify.env.get("KJ_PASSWORD") || "";
  const got = req.headers.get("x-kj-password") || "";
  if (!want || !got) return false;
  const a = createHash("sha256").update(want).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const s = store();

  if (req.method === "GET") {
    const [settings, items] = await Promise.all([readSettings(s), readQueue(s)]);
    return json({ open: settings.open !== false, items: items.map(({ id, name, artist, title, vendor, ts, status }) => ({ id, name, artist, title, vendor, ts, status })) });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const action = String(body?.action || "");

  // ---------- singers ----------
  if (action === "request") {
    const settings = await readSettings(s);
    if (settings.open === false) return json({ error: "Requests are closed right now." }, 403);
    const name = clean(body.name, 30), artist = clean(body.artist, 120), title = clean(body.title, 150), vendor = clean(body.vendor, 16);
    if (!name) return json({ error: "Please enter your name." }, 400);
    if (!title) return json({ error: "No song was selected." }, 400);

    const items = await readQueue(s);
    if (items.filter((i) => i.status !== "up").length >= MAX_WAITING) return json({ error: "The queue is full - try again a little later." }, 429);
    if (items.filter((i) => i.name.toLowerCase() === name.toLowerCase()).length >= MAX_PER_NAME)
      return json({ error: `You already have ${MAX_PER_NAME} songs in the queue.` }, 429);
    if (items.some((i) => i.artist.toLowerCase() === artist.toLowerCase() && i.title.toLowerCase() === title.toLowerCase()))
      return json({ error: "That song is already in the queue." }, 409);

    const who = createHash("sha256").update(String(context?.ip || "unknown")).digest("hex").slice(0, 24);
    const last = await s.get(`rl/${who}`, { type: "json" });
    const now = Date.now();
    if (last && now - last.ts < PER_PERSON_SECONDS * 1000) {
      const wait = Math.ceil((PER_PERSON_SECONDS * 1000 - (now - last.ts)) / 60000);
      return json({ error: `Please wait about ${wait} minute${wait > 1 ? "s" : ""} before requesting another song.` }, 429);
    }
    const id = now.toString(36).padStart(9, "0") + "-" + Math.random().toString(36).slice(2, 8);
    const item = { id, name, artist, title, vendor, ts: now, order: now, status: "waiting" };
    await s.setJSON(`q/${id}`, item);
    await s.setJSON(`rl/${who}`, { ts: now });
    const position = (await readQueue(s)).filter((i) => i.status !== "up").findIndex((i) => i.id === id) + 1;
    return json({ ok: true, item: { id, name, artist, title, vendor }, position });
  }

  // ---------- KJ ----------
  if (!isKJ(req)) return json({ error: "KJ password required." }, 401);
  if (action === "check") return json({ ok: true });

  if (action === "setOpen") {
    await s.setJSON("settings", { open: !!body.open });
    return json({ ok: true, open: !!body.open });
  }
  if (action === "clear") {
    const { blobs } = await s.list({ prefix: "q/" });
    await Promise.all(blobs.map((b) => s.delete(b.key)));
    return json({ ok: true, removed: blobs.length });
  }

  const id = clean(body.id, 40);
  const item = id && (await s.get(`q/${id}`, { type: "json" }));
  if (!item) return json({ error: "That request is no longer in the queue." }, 404);

  if (action === "done" || action === "remove") {
    await s.delete(`q/${id}`);
    return json({ ok: true });
  }
  if (action === "up") {
    // only one singer is "up" at a time: put the current one back at the front of the line
    const all = await readQueue(s);
    const front = Math.min(...all.map((i) => i.order ?? i.ts)) - 1;
    for (const other of all.filter((i) => i.status === "up" && i.id !== id)) {
      await s.setJSON(`q/${other.id}`, { ...other, status: "waiting", order: front });
    }
    await s.setJSON(`q/${id}`, { ...item, status: "up" });
    return json({ ok: true });
  }
  if (action === "move") {
    const waiting = (await readQueue(s)).filter((i) => i.status !== "up");
    const at = waiting.findIndex((i) => i.id === id);
    const to = at + (body.dir === "up" ? -1 : 1);
    if (at < 0 || to < 0 || to >= waiting.length) return json({ ok: true });
    const a = waiting[at], b = waiting[to];
    const oa = a.order ?? a.ts, ob = b.order ?? b.ts;
    await s.setJSON(`q/${a.id}`, { ...a, order: ob });
    await s.setJSON(`q/${b.id}`, { ...b, order: oa === ob ? ob + (body.dir === "up" ? 1 : -1) : oa });
    return json({ ok: true });
  }
  return json({ error: "Unknown action." }, 400);
};

export const config = { path: "/api/queue" };
