const express = require("express");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const app = express();
const PORT = 3000;

// ─── Middleware ───────────────────────────────────────────────
// Parse JSON request bodies so we can read req.body
app.use(express.json());

// Serve the frontend UI at root "/"
app.use(express.static(path.join(__dirname, "public")));

// ─── In-Memory Database ──────────────────────────────────────
// A simple JavaScript object acts as our "database".
// Key   = UUID (e.g. "110e8400-e29b-41d4-a716-446655440000")
// Value = original URL (e.g. "https://google.com")
const urlDatabase = {};

// ─── POST /shorten ───────────────────────────────────────────
// Request body:  { "url": "https://example.com" }
// Response:      { "shortUrl": "http://localhost:3000/a3Bf12" }
//
// Flow:
//   1. Read the original URL from the request body
//   2. Validate it
//   3. Increment the counter and encode it to Base62 → short code
//   4. Store the mapping in our in-memory database
//   5. Return the short URL to the client

app.post("/shorten", (req, res) => {
  const { url } = req.body;

  // Validation: make sure a URL was provided
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  // Return existing short code if URL was already shortened
  const existingCode = Object.keys(urlDatabase).find(
    (code) => urlDatabase[code] === url
  );
  if (existingCode) {
    const shortUrl = `http://localhost:${PORT}/${existingCode}`;
    return res.status(200).json({
      shortUrl,
      shortCode: existingCode,
      originalUrl: url,
    });
  }

  // Generate a unique key using UUID v4
  const shortCode = uuidv4();

  // Save to our in-memory database
  urlDatabase[shortCode] = url;

  // Build and return the short URL
  const shortUrl = `http://localhost:${PORT}/${shortCode}`;

  console.log(`[SHORTENED] ${url} → ${shortUrl}`);

  return res.status(201).json({
    shortUrl,
    shortCode,
    originalUrl: url,
  });
});

// ─── GET /:code ──────────────────────────────────────────────
// When someone visits http://localhost:3000/a3Bf12
//
// Flow:
//   1. Extract the short code from the URL parameter
//   2. Look it up in our in-memory database
//   3. If found → redirect (HTTP 302) to the original URL
//   4. If not found → return 404 error

app.get("/:code", (req, res) => {
  const { code } = req.params;

  // Look up the short code in our database
  const originalUrl = urlDatabase[code];

  if (!originalUrl) {
    return res.status(404).json({ error: "Short URL not found" });
  }

  console.log(`[REDIRECT] /${code} → ${originalUrl}`);

  // 302 = temporary redirect (browser goes to the original URL)
  return res.redirect(302, originalUrl);
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`URL Shortener running at http://localhost:${PORT}`);
  console.log();
  console.log("Usage:");
  console.log("  POST /shorten  → body: { \"url\": \"https://example.com\" }");
  console.log("  GET  /:code    → redirects to the original URL");
});
