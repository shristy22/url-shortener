require("dotenv").config();
const express = require("express");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app = express();
const PORT = 3000;

// Default expiry: 7 days in milliseconds
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// ─── PostgreSQL Connection ────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

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

// ─── POST /shorten ───────────────────────────────────────────
// Request body: { "url": "https://example.com", "expiryMs": 60000 }
// expiryMs is optional — defaults to 7 days

app.post("/shorten", async (req, res) => {
  const { url, expiryMs } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  // Return existing short code if URL was already shortened (and not expired)
  const existing = await pool.query(
    `SELECT short_code, expires_at FROM urls
     WHERE original_url = $1 AND expires_at > NOW()
     LIMIT 1`,
    [url]
  );

  if (existing.rows.length > 0) {
    const { short_code, expires_at } = existing.rows[0];
    const shortUrl = `http://localhost:${PORT}/${short_code}`;
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
    [shortCode, url, expiresAt]
  );

  const shortUrl = `http://localhost:${PORT}/${shortCode}`;
  console.log(`[SHORTENED] ${url} → ${shortUrl} (expires: ${expiresAt.toISOString()})`);

  return res.status(201).json({
    shortUrl,
    shortCode,
    originalUrl: url,
    expiresAt: expiresAt.toISOString(),
  });
});

// ─── GET /:code ──────────────────────────────────────────────

app.get("/:code", async (req, res) => {
  const { code } = req.params;

  const result = await pool.query(
    `SELECT original_url, expires_at FROM urls WHERE short_code = $1`,
    [code]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Short URL not found" });
  }

  const { original_url, expires_at } = result.rows[0];

  // Check if the URL has expired
  if (new Date() > new Date(expires_at)) {
    return res.status(410).json({ error: "Short URL has expired" });
  }

  console.log(`[REDIRECT] /${code} → ${original_url}`);
  res.set("Cache-Control", "no-store");
  return res.redirect(302, original_url);
});

// ─── Start Server ────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`URL Shortener running at http://localhost:${PORT}`);
      console.log();
      console.log("Usage:");
      console.log('  POST /shorten  → body: { "url": "https://example.com", "expiryMs": 60000 }');
      console.log("  GET  /:code    → redirects to the original URL (or 410 if expired)");
    });
  })
  .catch((err) => {
    console.error("[DB] Failed to connect to PostgreSQL:", err.message);
    process.exit(1);
  });
