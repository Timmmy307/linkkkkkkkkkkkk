// server.js (GitHub-backed, fixed)
import express from "express";
import cors from "cors";
import helmet from "helmet";
import axios from "axios";
import cheerio from "cheerio";
import { nanoid } from "nanoid";

const app = express();
const PORT = process.env.PORT || 10000;

// ==== CORS (set your static site origin) ====
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

// ==== GitHub repo config (REQUIRED) ====
// Example: GITHUB_REPO="yourname/your-private-repo"
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO   = process.env.GITHUB_REPO || "";        // "owner/name"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

// paths in the repo
const URLS_PATH  = "data/urls.json";
const PINS_PATH  = "data/pins.json";
const STATE_PATH = "data/state.json";

// basic guard
if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.warn("[WARN] Missing GITHUB_TOKEN or GITHUB_REPO. API will error on data access.");
}

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
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
app.options("*", cors());

// ================= GitHub storage helpers =================
const gh = axios.create({
  baseURL: `https://api.github.com/repos/${GITHUB_REPO}`,
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "weekly-link-giver/1.0",
    Accept: "application/vnd.github+json"
  },
  timeout: 10000
});

// Fetch file content + sha from GitHub; auto-create if missing.
async function ghGetOrInit(jsonPath, initValue) {
  try {
    const { data } = await gh.get(`/contents/${encodeURIComponent(jsonPath)}`, {
      params: { ref: GITHUB_BRANCH }
    });
    const content = Buffer.from(data.content || "", "base64").toString("utf8");
    return { json: JSON.parse(content || "{}"), sha: data.sha };
  } catch (e) {
    if (e.response?.status === 404) {
      const res = await ghPut(jsonPath, initValue, null, `init ${jsonPath}`);
      return { json: initValue, sha: res.sha };
    }
    throw e;
  }
}

// Put JSON to GitHub with optimistic concurrency (sha optional)
async function ghPut(jsonPath, jsonValue, sha, message) {
  const payload = {
    message: message || `update ${jsonPath}`,
    content: Buffer.from(JSON.stringify(jsonValue, null, 2)).toString("base64"),
    branch: GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;

  const { data } = await gh.put(`/contents/${encodeURIComponent(jsonPath)}`, payload);
  return { sha: data.content.sha };
}

// Update with a single retry on conflict
async function ghUpdate(jsonPath, mutator, initValue, commitMsg) {
  const { json, sha } = await ghGetOrInit(jsonPath, initValue);
  const updated = mutator(json);
  try {
    await ghPut(jsonPath, updated, sha, commitMsg);
    return updated;
  } catch (e) {
    if (e.response?.status === 409) {
      const fresh = await ghGetOrInit(jsonPath, initValue);
      const updated2 = mutator(fresh.json);
      await ghPut(jsonPath, updated2, fresh.sha, commitMsg + " (retry)");
      return updated2;
    }
    throw e;
  }
}

async function ghRead(jsonPath, initValue) {
  const { json } = await ghGetOrInit(jsonPath, initValue);
  return json;
}

// ================= Page meta probe =================
async function getPageMeta(targetUrl) {
  let title = "";
  let favicon = "";
  try {
    const resp = await axios.get(targetUrl, { timeout: 8000 });
    const $ = cheerio.load(resp.data);
    title = $("title").first().text().trim() || "";

    let iconHref =
      $('link[rel="icon"]').attr("href") ||
      $('link[rel="shortcut icon"]').attr("href") ||
      $('link[rel="apple-touch-icon"]').attr("href") || "";

    if (iconHref) {
      const u = new URL(iconHref, targetUrl);
      favicon = u.href;
    } else {
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

// ================= Simple in-memory admin tokens =================
function randomToken() { return "adm_" + nanoid(16); }
app.locals.tokens = new Set();

async function checkPin(pin) {
  const pins = await ghRead(PINS_PATH, { pins: ["1234"] });
  return pins.pins?.map(String).includes(String(pin));
}

// ================= Public API =================
app.get("/api/urls", async (req, res) => {
  try {
    const urls = await ghRead(URLS_PATH, { urls: [] });
    const state = await ghRead(STATE_PATH, { enabled: true });
    const onlyActive = req.query.all === "1" ? urls.urls : urls.urls.filter((u) => u.active !== false);
    res.json({
      ok: true,
      enabled: !!state.enabled,
      urls: onlyActive.map(({ id, title, favicon, url }) => ({ id, title, favicon, url }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "read failed" });
  }
});

app.get("/api/resolve/:id", async (req, res) => {
  try {
    const state = await ghRead(STATE_PATH, { enabled: true });
    if (!state.enabled) return res.status(403).json({ ok: false, error: "Access disabled" });

    const urls = await ghRead(URLS_PATH, { urls: [] });
    const item = urls.urls.find((u) => u.id === req.params.id && u.active !== false);
    if (!item) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, id: item.id, title: item.title, favicon: item.favicon, url: item.url });
  } catch (e) {
    res.status(500).json({ ok: false, error: "resolve failed" });
  }
});

app.post("/api/probe", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  try {
    const meta = await getPageMeta(url);
    res.json({ ok: true, meta });
  } catch {
    res.status(500).json({ ok: false, error: "probe failed" });
  }
});

// ================= Admin API =================
app.post("/api/admin/login", async (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !(await checkPin(pin))) return res.status(401).json({ ok: false, error: "bad pin" });
  const token = randomToken();
  app.locals.tokens.add(token);
  res.json({ ok: true, token });
});

function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.replace("Bearer ", "");
  if (!token || !app.locals.tokens.has(token)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// ✅ FIXED: `res` was truncated before. This is the corrected route.
app.post("/api/admin/add", auth, async (req, res) => {
  const { url, title, favicon } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url required" });
  try {
    const result = await ghUpdate(
      URLS_PATH,
      (db) => {
        db.urls = db.urls || [];
        const id = nanoid(10);
        db.urls.push({
          id,
          url,
          title: title || "",
          favicon: favicon || "",
          active: true,
          createdAt: Date.now()
        });
        return db;
      },
      { urls: [] },
      "admin add url"
    );

    const last = result.urls[result.urls.length - 1];
    if (!title || !favicon) {
      try {
        const meta = await getPageMeta(url);
        await ghUpdate(
          URLS_PATH,
          (db) => {
            const idx = db.urls.findIndex((u) => u.id === last.id);
            if (idx >= 0) {
              db.urls[idx].title = db.urls[idx].title || meta.title || new URL(url).hostname;
              db.urls[idx].favicon = db.urls[idx].favicon || meta.favicon || "";
            }
            return db;
          },
          { urls: [] },
          "fill title/favicon"
        );
      } catch {}
    }

    res.json({ ok: true, id: last.id });
  } catch {
    res.status(500).json({ ok: false, error: "add failed" });
  }
});

app.delete("/api/admin/remove/:id", auth, async (req, res) => {
  try {
    let removed = 0;
    await ghUpdate(
      URLS_PATH,
      (db) => {
        const before = (db.urls || []).length;
        db.urls = (db.urls || []).filter((u) => u.id !== req.params.id);
        removed = before - db.urls.length;
        return db;
      },
      { urls: [] },
      "admin remove url"
    );
    res.json({ ok: true, removed });
  } catch {
    res.status(500).json({ ok: false, error: "remove failed" });
  }
});

app.post("/api/admin/toggle", auth, async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ ok: false, error: "enabled boolean required" });
  try {
    const updated = await ghUpdate(
      STATE_PATH,
      (_db) => ({ enabled }),
      { enabled: true },
      "toggle service state"
    );
    res.json({ ok: true, enabled: updated.enabled });
  } catch {
    res.status(500).json({ ok: false, error: "toggle failed" });
  }
});

app.get("/", (_req, res) => res.json({ ok: true, service: "weekly-link-giver (github-backed)" }));

app.listen(PORT, () => console.log(`API on ${PORT}`));
