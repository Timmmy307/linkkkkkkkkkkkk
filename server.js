// server.js
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "fs";
import path from "path";
import axios from "axios";
import cheerio from "cheerio";
import { nanoid } from "nanoid";

const app = express();
const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*"; // set your static site origin in Render env

// --- file paths (Render disk is ephemeral; commit these to repo) ---
const DATA_DIR = "./data";
const URLS_FILE = path.join(DATA_DIR, "urls.json");
const PINS_FILE = path.join(DATA_DIR, "pins.json");
const STATE_FILE = path.join(DATA_DIR, "state.json"); // {enabled:true}

// --- bootstrap data folder ---
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(URLS_FILE)) fs.writeFileSync(URLS_FILE, JSON.stringify({ urls: [] }, null, 2));
if (!fs.existsSync(PINS_FILE)) fs.writeFileSync(PINS_FILE, JSON.stringify({ pins: ["1234"] }, null, 2)); // replace in repo
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: true }, null, 2));

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// CORS: allow your static site origin + preflight for all API routes
// Docs show enabling dynamic or static origins and handling preflight. :contentReference[oaicite:0]{index=0}
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || FRONTEND_ORIGIN === "*" || origin === FRONTEND_ORIGIN) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false
  })
);
app.options("*", cors()); // handle preflight; recommended for tricky deployments. :contentReference[oaicite:1]{index=1}

// ---- helpers ----
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

// Try to discover title & favicon of a URL.
// Strategy: GET HTML, parse <title>, look for <link rel=icon/...>, else fall back to /favicon.ico. :contentReference[oaicite:2]{index=2}
async function getPageMeta(targetUrl) {
  let title = "";
  let favicon = "";

  try {
    const resp = await axios.get(targetUrl, { timeout: 8000 });
    const $ = cheerio.load(resp.data);

    // title
    const t = $("title").first().text().trim();
    if (t) title = t;

    // prefer modern rel values
    let iconHref =
      $('link[rel="icon"]').attr("href") ||
      $('link[rel="shortcut icon"]').attr("href") ||
      $('link[rel="apple-touch-icon"]').attr("href") ||
      "";

    if (iconHref) {
      const u = new URL(iconHref, targetUrl);
      favicon = u.href;
    } else {
      // fallback
      const base = new URL(targetUrl);
      favicon = `${base.origin}/favicon.ico`;
    }
  } catch {
    try {
      const base = new URL(targetUrl);
      favicon = `${base.origin}/favicon.ico`;
    } catch {}
  }

  return { title, favicon };
}

// --- public API ---
// Get list of available URLs (active only by default)
app.get("/api/urls", (req, res) => {
  const { urls } = readJSON(URLS_FILE);
  const { enabled } = readJSON(STATE_FILE);
  const onlyActive = req.query.all === "1" ? urls : urls.filter((u) => u.active !== false);
  res.json({ ok: true, enabled, urls: onlyActive.map(({ id, title, favicon, url }) => ({ id, title, favicon, url })) });
});

// Resolve a URL by id after client confirms. We return {title, favicon, url}.
// The client handles localStorage “weekly” rule; the server stays stateless for students.
app.get("/api/resolve/:id", (req, res) => {
  const { id } = req.params;
  const { enabled } = readJSON(STATE_FILE);
  if (!enabled) return res.status(403).json({ ok: false, error: "Access disabled" });

  const { urls } = readJSON(URLS_FILE);
  const item = urls.find((u) => u.id === id && u.active !== false);
  if (!item) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, id, title: item.title, favicon: item.favicon, url: item.url });
});

// probe meta for a given URL (used by admin when adding new)
app.post("/api/probe", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  try {
    const meta = await getPageMeta(url);
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: "probe failed" });
  }
});

// ---- admin ----
function checkPin(pin) {
  const { pins } = readJSON(PINS_FILE);
  return pins.includes(String(pin));
}

app.post("/api/admin/login", (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !checkPin(pin)) return res.status(401).json({ ok: false, error: "bad pin" });
  // simple ephemeral token (not a JWT; fine for hidden owner panel)
  const token = "adm_" + nanoid(16);
  // In-memory token allowlist (reset on reboot). For Render free, that’s okay.
  // If you want persistence, write a small token list file.
  app.locals.tokens = app.locals.tokens || new Set();
  app.locals.tokens.add(token);
  res.json({ ok: true, token });
});

function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.replace("Bearer ", "");
  if (!token || !app.locals.tokens || !app.locals.tokens.has(token)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

app.post("/api/admin/add", auth, async (req, res) => {
  const { url, title, favicon } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  const db = readJSON(URLS_FILE);
  const id = nanoid(10);
  let meta = { title: title || "", favicon: favicon || "" };
  if (!meta.title || !meta.favicon) {
    try {
      const pr = await getPageMeta(url);
      meta = { title: meta.title || pr.title || new URL(url).hostname, favicon: meta.favicon || pr.favicon || "" };
    } catch {
      meta = { title: meta.title || new URL(url).hostname, favicon: meta.favicon || "" };
    }
  }
  db.urls.push({ id, url, title: meta.title, favicon: meta.favicon, active: true, createdAt: Date.now() });
  writeJSON(URLS_FILE, db);
  res.json({ ok: true, id });
});

app.delete("/api/admin/remove/:id", auth, (req, res) => {
  const db = readJSON(URLS_FILE);
  const before = db.urls.length;
  db.urls = db.urls.filter((u) => u.id !== req.params.id);
  writeJSON(URLS_FILE, db);
  res.json({ ok: true, removed: before - db.urls.length });
});

app.post("/api/admin/toggle", auth, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ ok: false, error: "enabled boolean required" });
  writeJSON(STATE_FILE, { enabled });
  res.json({ ok: true, enabled });
});

app.get("/", (_req, res) => res.json({ ok: true, service: "weekly-link-giver" }));

app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
});
