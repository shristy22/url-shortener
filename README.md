# URL Shortener

A simple URL shortener built with Node.js and Express. Converts long URLs into short, shareable links using Base62 encoding.

## Features

- Shorten any URL to a compact code
- Automatically reuses the same short code if the same URL is submitted again
- Redirects short URLs back to the original
- Clean web UI to shorten and test links

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) installed

### Installation

```bash
npm install
```

### Run the server

```bash
node server.js
```

Then open your browser at `http://localhost:3000`

## Usage

### Web UI

1. Paste a long URL into the input field
2. Click **Shorten URL**
3. Click the generated short link to test the redirect

### API

**Shorten a URL**

```
POST /shorten
Content-Type: application/json

{ "url": "https://example.com/some/long/path" }
```

Response:

```json
{
  "shortUrl": "http://localhost:3000/b",
  "shortCode": "b",
  "originalUrl": "https://example.com/some/long/path"
}
```

**Redirect via short code**

```
GET /:code
```

Redirects (HTTP 302) to the original URL.

## How It Works

- Each new URL is assigned an incrementing counter value
- The counter is encoded to **Base62** (a–z, A–Z, 0–9) to produce a short code
- If the same URL is submitted again, the existing short code is returned — no duplicate entries
- All data is stored **in memory** (resets when the server restarts)

## Project Structure

```
url-shortner/
├── public/
│   └── index.html   # Frontend UI
├── server.js        # Express server & API
├── package.json
└── README.md
```
