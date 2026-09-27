// ============================================================
//  SIKE HUB - Key Server
//  Luong: Script -> /api/getlink -> user vuot link4m ->
//         getkey.html -> /api/redeem (cap key 48h) ->
//         Script -> /api/verify moi lan chay
//  Yeu cau: Node 18+
//  Bien moi truong:
//    LINK4M_API, SITE_URL, KEY_TTL_HOURS (mac dinh 48)
//    ADMIN_KEY          -> mo khoa /api/admin/* + admin.html
//    DISCORD_WEBHOOK    -> (tuy chon) bao key moi qua Discord
//    UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//      -> (tuy chon nhung KHUYEN NGHI) luu key ben ngoai, khong mat
//         khi Render free tier redeploy/restart (o dia cuc bo bi xoa
//         moi lan container khoi dong lai). Tao free o upstash.com,
//         copy 2 gia tri "REST URL" va "REST TOKEN".
//         Khong dien -> tu dong fallback ve file keys.json (cu).
// ============================================================

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors()); // cho phep getkey.html (github pages) goi API
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LINK4M_API = (process.env.LINK4M_API || "").trim();
const SITE_URL = (process.env.SITE_URL || "").trim().replace(/\/$/, ""); // vd: https://tenban.github.io/sikehub (KHONG co / cuoi)
const KEY_TTL_HOURS = parseInt(process.env.KEY_TTL_HOURS || "48", 10);
const TOKEN_TTL_MIN = 30; // link lay-key chi song 30 phut
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const DISCORD_WEBHOOK = (process.env.DISCORD_WEBHOOK || "").trim();

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_DB_KEY = "sikehub:db";

const DB_PATH = path.join(__dirname, "keys.json");
const EMPTY_DB = () => ({ keys: {}, pending: {}, stats: { totalIssued: 0, totalRedeems: 0 } });

// ---------- storage layer ----------
// 2 backend: Upstash Redis REST (ben vung, khuyen dung tren Render free)
// hoac file keys.json cuc bo (mac dinh, mat du lieu khi container redeploy).
let db = EMPTY_DB();

async function loadDB() {
  if (USE_REDIS) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${REDIS_DB_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      });
      const j = await r.json();
      if (j && j.result) {
        const raw = JSON.parse(j.result);
        return { keys: raw.keys || {}, pending: raw.pending || {}, stats: raw.stats || { totalIssued: 0, totalRedeems: 0 } };
      }
    } catch (e) {
      console.error("[Redis] load error:", e.message);
    }
    return EMPTY_DB();
  }
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      return { keys: raw.keys || {}, pending: raw.pending || {}, stats: raw.stats || { totalIssued: 0, totalRedeems: 0 } };
    }
  } catch (e) {
    console.error("[DB] load error:", e.message);
  }
  return EMPTY_DB();
}

async function saveDB() {
  if (USE_REDIS) {
    try {
      await fetch(`${UPSTASH_URL}/set/${REDIS_DB_KEY}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "text/plain" },
        body: JSON.stringify(db),
      });
    } catch (e) {
      console.error("[Redis] save error:", e.message);
    }
    return;
  }
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("[DB] save error:", e.message);
  }
}

// ---------- helpers ----------
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bo I,O,0,1 cho de doc

function genKey() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const parts = [];
    for (let p = 0; p < 3; p++) {
      let s = "";
      const bytes = crypto.randomBytes(4);
      for (let i = 0; i < 4; i++) s += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
      parts.push(s);
    }
    const key = "SIKE-" + parts.join("-");
    if (!db.keys[key]) return key; // dam bao KHONG trung
  }
  // fallback (hiem khi xay ra)
  return "SIKE-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function cleanup() {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(db.keys)) {
    if (!v.expiresAt || v.expiresAt <= now) { delete db.keys[k]; changed = true; }
  }
  for (const [t, v] of Object.entries(db.pending)) {
    if (v.used || !v.createdAt || now - v.createdAt > TOKEN_TTL_MIN * 60 * 1000) {
      delete db.pending[t]; changed = true;
    }
  }
  if (changed) await saveDB();
}
setInterval(() => { cleanup().catch(() => {}); }, 10 * 60 * 1000);

function validHwid(h) {
  return typeof h === "string" && h.length >= 3 && h.length <= 256 && !/[\s"'<>\\`]/.test(h);
}

// ---------- rate limiting don gian, theo IP (khong can dependency ngoai) ----------
// windowMs: khoang thoi gian; max: so request toi da trong khoang do.
function makeRateLimiter(windowMs, max) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits.entries()) {
      const kept = arr.filter(t => now - t < windowMs);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, windowMs).unref?.();
  return function limiter(req, res, next) {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim();
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
    arr.push(now);
    hits.set(ip, arr);
    if (arr.length > max) {
      return res.status(429).json({ status: "error", message: "Qua nhieu request, thu lai sau it phut." });
    }
    next();
  };
}
const limitGetlink = makeRateLimiter(60 * 1000, 10);  // 10 lan/phut/IP
const limitVerify  = makeRateLimiter(60 * 1000, 60);  // 60 lan/phut/IP (script goi verify thuong xuyen)

// chong spam getlink: moi HWID 60s/lan
const lastLinkAt = {};

// ---------- admin auth ----------
function isAdmin(req) {
  if (!ADMIN_KEY) return false; // chua cau hinh ADMIN_KEY -> khoa toan bo admin API
  const supplied = (req.query.admin || req.headers["x-admin-key"] || "").toString();
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) { res.status(503).json({ status: "error", message: "Admin chua duoc cau hinh (thieu ADMIN_KEY)." }); return false; }
  if (!isAdmin(req)) { res.status(401).json({ status: "error", message: "Sai admin key." }); return false; }
  return true;
}

// ---------- optional: bao Discord khi co key moi ----------
function notifyDiscord(content) {
  if (!DISCORD_WEBHOOK) return;
  fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch(() => {});
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({
    status: "success",
    service: "SIKE HUB Key Server",
    storage: USE_REDIS ? "upstash-redis" : "local-file",
    time: new Date().toISOString(),
  });
});

// B1: Script goi de lay link vuot (da rut gon bang Link4m)
app.get("/api/getlink", limitGetlink, async (req, res) => {
  const hwid = (req.query.hwid || "").toString().trim();
  if (!validHwid(hwid)) return res.json({ status: "error", message: "Thieu HWID hop le." });
  if (!LINK4M_API) return res.json({ status: "error", message: "Server chua cau hinh LINK4M_API." });
  if (!SITE_URL) return res.json({ status: "error", message: "Server chua cau hinh SITE_URL." });

  const now = Date.now();
  if (lastLinkAt[hwid] && now - lastLinkAt[hwid] < 60 * 1000) {
    return res.json({ status: "error", message: "Cho 60s roi lay link moi." });
  }
  lastLinkAt[hwid] = now;

  const token = crypto.randomBytes(16).toString("hex");
  db.pending[token] = { hwid, createdAt: now, used: false };
  await saveDB();

  const dest = `${SITE_URL}/getkey.html?hwid=${encodeURIComponent(hwid)}&token=${token}`;
  // LUU Y: dung POST form thay vi GET. Cloudflare WAF cua link4m chan
  // tham so `url=` tren query string (403), nhung cho phep POST body.
  try {
    const r = await fetch("https://link4m.co/api-shorten/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      body: new URLSearchParams({ api: LINK4M_API, url: dest }).toString(),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* Cloudflare HTML */ }
    if (data && data.status === "success" && data.shortenedUrl) {
      return res.json({ status: "success", link: data.shortenedUrl });
    }
    if (data && data.message) {
      return res.json({ status: "error", message: "Link4m loi: " + data.message });
    }
    return res.json({ status: "error", message: "Link4m chan request (HTTP " + r.status + "). Thu lai sau." });
  } catch (e) {
    return res.json({ status: "error", message: "Khong goi duoc Link4m API." });
  }
});

// B2: Trang getkey.html goi sau khi user vuot link -> cap key 48h theo may
app.get("/api/redeem", async (req, res) => {
  const hwid = (req.query.hwid || "").toString().trim();
  const token = (req.query.token || "").toString().trim();
  if (!validHwid(hwid) || !/^[a-f0-9]{32}$/.test(token)) {
    return res.json({ status: "error", message: "Link khong hop le. Hay lay link moi trong script." });
  }
  await cleanup();
  const p = db.pending[token];
  if (!p || p.used || p.hwid !== hwid) {
    return res.json({ status: "error", message: "Link het han hoac da dung. Hay lay link moi trong script." });
  }

  // may da co key con han -> tra lai key cu (khong farm key moi)
  for (const [k, v] of Object.entries(db.keys)) {
    if (v.hwid === hwid && v.expiresAt > Date.now()) {
      p.used = true; db.stats.totalRedeems++; await saveDB();
      return res.json({ status: "success", key: k, expiresAt: v.expiresAt, reused: true });
    }
  }

  const key = genKey();
  const now = Date.now();
  db.keys[key] = { hwid, createdAt: now, expiresAt: now + KEY_TTL_HOURS * 3600 * 1000 };
  p.used = true;
  db.stats.totalIssued++; db.stats.totalRedeems++;
  await saveDB();
  notifyDiscord(`🔑 Key moi: \`${key}\` — HWID \`${hwid}\` — het han <t:${Math.floor(db.keys[key].expiresAt/1000)}:R>`);
  return res.json({ status: "success", key, expiresAt: db.keys[key].expiresAt, reused: false });
});

// B3: Script kiem tra key moi lan chay
app.get("/api/verify", limitVerify, async (req, res) => {
  const key = (req.query.key || "").toString().trim().toUpperCase();
  const hwid = (req.query.hwid || "").toString().trim();
  if (!key || !validHwid(hwid)) {
    return res.json({ status: "success", valid: false, reason: "missing" });
  }
  const v = db.keys[key];
  if (!v) return res.json({ status: "success", valid: false, reason: "not_found" });
  if (v.hwid !== hwid) return res.json({ status: "success", valid: false, reason: "wrong_hwid" });
  if (v.expiresAt <= Date.now()) {
    delete db.keys[key]; await saveDB();
    return res.json({ status: "success", valid: false, reason: "expired" });
  }
  return res.json({ status: "success", valid: true, expiresAt: v.expiresAt });
});

// ---------- admin routes (bao ve boi ADMIN_KEY) ----------
app.get("/api/admin/stats", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await cleanup();
  const now = Date.now();
  const active = Object.values(db.keys);
  const expiringSoon = active.filter(v => v.expiresAt - now < 6 * 3600 * 1000).length;
  res.json({
    status: "success",
    activeKeys: active.length,
    pendingLinks: Object.keys(db.pending).length,
    totalIssued: db.stats.totalIssued || 0,
    totalRedeems: db.stats.totalRedeems || 0,
    expiringSoon,
    storage: USE_REDIS ? "upstash-redis" : "local-file",
  });
});

app.get("/api/admin/keys", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await cleanup();
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const list = Object.entries(db.keys)
    .map(([key, v]) => ({ key, hwid: v.hwid, createdAt: v.createdAt, expiresAt: v.expiresAt }))
    .filter(x => !q || x.key.toLowerCase().includes(q) || x.hwid.toLowerCase().includes(q))
    .sort((a, b) => a.expiresAt - b.expiresAt);
  res.json({ status: "success", keys: list });
});

app.get("/api/admin/revoke", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = (req.query.key || "").toString().trim().toUpperCase();
  if (!key || !db.keys[key]) return res.json({ status: "error", message: "Khong tim thay key." });
  delete db.keys[key];
  await saveDB();
  res.json({ status: "success", message: `Da thu hoi ${key}.` });
});

app.get("/api/admin/extend", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = (req.query.key || "").toString().trim().toUpperCase();
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours || "24", 10) || 24));
  if (!key || !db.keys[key]) return res.json({ status: "error", message: "Khong tim thay key." });
  db.keys[key].expiresAt += hours * 3600 * 1000;
  await saveDB();
  res.json({ status: "success", key, expiresAt: db.keys[key].expiresAt });
});

// them 1 key thu cong (vd: tang key VIP khong can vuot link) - can ADMIN_KEY
app.get("/api/admin/create", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const hwid = (req.query.hwid || "").toString().trim();
  const hours = Math.max(1, Math.min(8760, parseInt(req.query.hours || String(KEY_TTL_HOURS), 10) || KEY_TTL_HOURS));
  if (!validHwid(hwid)) return res.json({ status: "error", message: "Thieu HWID hop le." });
  const key = genKey();
  const now = Date.now();
  db.keys[key] = { hwid, createdAt: now, expiresAt: now + hours * 3600 * 1000 };
  db.stats.totalIssued++;
  await saveDB();
  res.json({ status: "success", key, expiresAt: db.keys[key].expiresAt });
});

async function start() {
  db = await loadDB();
  app.listen(PORT, () => {
    console.log(`[SIKE HUB] Key server chay o port ${PORT} | key TTL ${KEY_TTL_HOURS}h | storage: ${USE_REDIS ? "Upstash Redis" : "file keys.json (khong ben vung tren Render free!)"}`);
    if (!LINK4M_API) console.log("!! Chua co LINK4M_API (bien moi truong)");
    if (!SITE_URL) console.log("!! Chua co SITE_URL (bien moi truong)");
    if (!ADMIN_KEY) console.log("!! Chua co ADMIN_KEY -> /api/admin/* dang bi khoa");
  });
}
start();
