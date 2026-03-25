require("dotenv").config();
const express = require("express");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const { createClient } = require("redis");
const { rateLimit } = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Default expiry: 7 days in milliseconds
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// ─── PostgreSQL Connection ────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// ─── Redis Connection ─────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL });

redis.on("error", (err) => console.error("[REDIS] Client error:", err));

async function initRedis() {
  await redis.connect();
  console.log("[REDIS] Connected");
}

// Cache helpers
async function cacheGet(key) {
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null; // Redis down → fall through to DB
  }
}

async function cacheSet(key, value, ttlSeconds) {
  try {
    await redis.setEx(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Redis down → silent fail, DB is source of truth
  }
}

async function cacheDel(key) {
  try {
    await redis.del(key);
  } catch {
    /* silent */
  }
}

// ─── Create Table if not exists ──────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      short_code   TEXT PRIMARY KEY,
      original_url TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("[DB] Table ready");
}

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Rate Limiters ────────────────────────────────────────────
// POST /shorten: max 10 requests per 15 minutes per IP
const shortenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: {
    error: "Too many URLs shortened from this IP, try again after 15 minutes",
  },
  standardHeaders: "draft-8", // sends RateLimit headers in response
  legacyHeaders: false,
});

// GET /:code: max 60 redirects per minute per IP
const redirectLimiter = rateLimit({
  windowMs: 10 * 1000,
  limit: 2,
  message: {
    error: "Too many requests from this IP, try again after a minute",
  },
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

// ─── Validation helpers ───────────────────────────────────────
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_EXPIRY_MS = 60 * 1000; // 1 minute
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const MAX_URL_LENGTH = 2048;

function validateUrl(url) {
  if (!url || typeof url !== "string")
    return "url is required and must be a string";
  if (url.length > MAX_URL_LENGTH)
    return `url must be ${MAX_URL_LENGTH} characters or fewer`;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      return "url must use http or https";
  } catch {
    return "url is not a valid URL";
  }
  return null;
}

function validateExpiryMs(expiryMs) {
  if (expiryMs === undefined) return null; // optional field
  if (typeof expiryMs !== "number" || !Number.isInteger(expiryMs))
    return "expiryMs must be an integer";
  if (expiryMs < MIN_EXPIRY_MS)
    return `expiryMs must be at least ${MIN_EXPIRY_MS} (1 minute)`;
  if (expiryMs > MAX_EXPIRY_MS)
    return `expiryMs must be at most ${MAX_EXPIRY_MS} (1 year)`;
  return null;
}

function validateCode(code) {
  if (!UUID_REGEX.test(code)) return "invalid short code format";
  return null;
}

// ─── POST /shorten ───────────────────────────────────────────
// Request body: { "url": "https://example.com", "expiryMs": 60000 }
// expiryMs is optional — defaults to 7 days

app.post("/shorten", shortenLimiter, async (req, res) => {
  const { url, expiryMs } = req.body;

  const urlError = validateUrl(url);
  const expiryError = validateExpiryMs(expiryMs);
  if (urlError || expiryError) {
    return res
      .status(400)
      .json({ errors: [urlError, expiryError].filter(Boolean) });
  }

  // Return existing short code if URL was already shortened (and not expired)
  const existing = await pool.query(
    `SELECT short_code, expires_at FROM urls
     WHERE original_url = $1 AND expires_at > NOW()
     LIMIT 1`,
    [url],
  );

  if (existing.rows.length > 0) {
    const { short_code, expires_at } = existing.rows[0];
    const shortUrl = `${BASE_URL}/${short_code}`;
    return res.status(200).json({
      shortUrl,
      shortCode: short_code,
      originalUrl: url,
      expiresAt: expires_at,
    });
  }

  // Generate a unique key using UUID v4
  const shortCode = uuidv4();
  const expiresAt = new Date(Date.now() + (expiryMs || DEFAULT_EXPIRY_MS));

  await pool.query(
    `INSERT INTO urls (short_code, original_url, expires_at) VALUES ($1, $2, $3)`,
    [shortCode, url, expiresAt],
  );

  // Warm the cache immediately so first redirect is a cache hit
  const ttlSeconds = Math.floor((expiresAt - Date.now()) / 1000);
  await cacheSet(
    `url:${shortCode}`,
    { original_url: url, expires_at: expiresAt },
    ttlSeconds,
  );
  const shortUrl = `${BASE_URL}/${shortCode}`;
  console.log(
    `[SHORTENED] ${url} → ${shortUrl} (expires: ${expiresAt.toISOString()})`,
  );

  return res.status(201).json({
    shortUrl,
    shortCode,
    originalUrl: url,
    expiresAt: expiresAt.toISOString(),
  });
});

// ─── GET /:code ──────────────────────────────────────────────

app.get("/:code", redirectLimiter, async (req, res) => {
  const { code } = req.params;

  const codeError = validateCode(code);
  if (codeError) {
    return res.status(400).json({ error: codeError });
  }

  // ── 1. Cache lookup ───────────────────────────────────────────
  const cached = await cacheGet(`url:${code}`);
  if (cached) {
    console.log(`[CACHE HIT] /${code} → ${cached.original_url}`);
    res.set("Cache-Control", "no-store");

    res.redirect(302, cached.original_url);
  }

  // ── 2. Cache miss → go to DB ──────────────────────────────────
  const result = await pool.query(
    `SELECT original_url, expires_at FROM urls WHERE short_code = $1`,
    [code],
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Short URL not found" });
  }

  const { original_url, expires_at } = result.rows[0];

  if (new Date() > new Date(expires_at)) {
    await cacheDel(`url:${code}`); // clean up if somehow cached
    return res.status(410).json({ error: "Short URL has expired" });
  }

  // ── 3. Populate cache for next request ───────────────────────
  const ttlSeconds = Math.floor((new Date(expires_at) - Date.now()) / 1000);
  await cacheSet(`url:${code}`, { original_url, expires_at }, ttlSeconds);

  console.log(`[CACHE MISS] /${code} → ${original_url}`);
  res.set("Cache-Control", "no-store");
  return res.redirect(302, original_url);
});

// ─── Start Server ────────────────────────────────────────────
Promise.all([initDB(), initRedis()])
  .then(() => {
    app.listen(PORT, () => {
      console.log(`URL Shortener running at ${BASE_URL}`);
      console.log();
      console.log("Usage:");
      console.log(
        '  POST /shorten  → body: { "url": "https://example.com", "expiryMs": 60000 }',
      );
      console.log(
        "  GET  /:code    → redirects to the original URL (or 410 if expired)",
      );
    });
  })
  .catch((err) => {
    console.error("[STARTUP] Failed to connect:", err.message);
    process.exit(1);
  });
