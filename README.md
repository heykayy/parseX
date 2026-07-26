# ParseX — Document Intelligence

> Hybrid AI document analyser. Precision multi-format extraction × AI-powered summarisation and Q&A generation.

![ParseX](https://img.shields.io/badge/ParseX-Document%20Intelligence-2563eb?style=for-the-badge)
![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react)
![Vite](https://img.shields.io/badge/Vite-latest-646cff?style=flat-square&logo=vite)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?style=flat-square&logo=node.js)

**Live app:** https://parse-x-snowy.vercel.app
**API health check:** https://parsex.onrender.com/health

> The backend runs on Render's free tier and sleeps after ~15 min of inactivity — the first request after a period of no traffic may take 30–50s while it wakes up.

---

## What is ParseX?

ParseX is a full-stack web application that takes any document — PDF, DOCX, JSON, Markdown, CSV, or plain text — extracts and cleans the text with a precision multi-engine pipeline, then uses an AI language model to generate a structured summary and a set of smart Q&A pairs.

It is built as a **hybrid architecture**: the extraction and cleaning layer is powered by a custom JavaScript port of a production-grade text processing pipeline, while the AI summarisation and Q&A generation uses a provider-agnostic abstraction that supports Claude (Anthropic), Gemini (Google), and GPT-4o (OpenAI / GitHub Copilot) — switchable with a single line of config.

---

## Features

- **Multi-format extraction** — PDF (layout-aware), DOCX, JSON (recursive), Markdown, CSV, TXT
- **Smart text normalisation** — noise removal, camelCase splitting, hyphenated line-break rejoining, citation stripping, protected-term preservation
- **Academic header detection** — automatically skips cover pages and preamble in research papers
- **Map-Reduce summarisation** — large documents are split into overlapping 8 KB chunks, each summarised independently, then synthesised into one coherent final summary
- **Generative Q&A** — context-aware question and answer pairs generated from the full document summary
- **Multi-provider AI** — switch between Claude, Gemini, and GPT-4o with one config line
- **Secure backend proxy** — API keys never reach the browser; all AI calls route through an Express server
- **Configurable output** — set summary word limit (100–1000) and Q&A pair count (3–20) before uploading
- **Export** — download results as JSON or TXT
- **Theme system** — light, dark, and system-preference modes
- **Layout modes** — compact, comfortable, spacious

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite |
| Styling | CSS variables, custom design system |
| PDF parsing | PDF.js (browser-native) |
| DOCX parsing | mammoth.js |
| Backend | Node.js, Express |
| AI providers | Anthropic Claude · Google Gemini · OpenAI GPT-4o |
| Rate limiting | express-rate-limit |
| Deployment | Vercel (frontend) · Render (backend) |

---

## Project Structure

```
parsex/
├── index.html              # HTML shell — React mounts here
├── package.json            # Frontend dependencies (React, Vite, jsonrepair)
├── vite.config.js          # Vite config + dev-only proxy to local backend
├── .gitignore
│
├── src/
│   ├── main.jsx            # Entry point — mounts ParseX into the DOM
│   └── ParseX.jsx          # The entire frontend application
│
└── server/
    ├── index.js            # Express server — AI API proxy
    ├── package.json        # Backend dependencies (Express, dotenv, cors)
    ├── .env                # Your API keys — never committed
    └── .env.example        # Key template — safe to commit
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) installed on your machine
- An API key from at least one of:
  - [Anthropic Console](https://console.anthropic.com) — for Claude
  - [Google AI Studio](https://aistudio.google.com/app/apikey) — for Gemini
  - [OpenAI Platform](https://platform.openai.com/api-keys) — for GPT-4o

---

### Installation

**1. Clone the repository**

```bash
git clone https://github.com/heykayy/parseX.git
cd parseX
```

**2. Install frontend dependencies**

```bash
npm install
```

**3. Install backend dependencies**

```bash
cd server
npm install
```

**4. Configure your API keys**

```bash
# still inside the server/ folder
copy .env.example .env
```

Open `server/.env` and fill in whichever keys you have:

```env
ANTHROPIC_KEY=sk-ant-your-key-here
GEMINI_KEY=AIza-your-key-here
OPENAI_KEY=sk-your-key-here
PORT=3001
```

You only need the key for the provider you plan to use.

**5. Set your active AI provider**

In `src/ParseX.jsx`, find this line near the bottom of the `PROVIDER_CONFIG` object:

```js
activeProvider: "gemini"   // change to "claude" or "openai"
```

The deployed production build uses Gemini, since Google's Gemini API offers an ongoing free tier with no trial-period expiry — unlike OpenAI's time-limited trial credits. Claude and GPT-4o both work identically if you'd rather use those; just add the matching key to `server/.env`.

---

### Running Locally

You need two terminals open at the same time.

**Terminal 1 — start the backend server**

```powershell
cd server
npm run dev
# → ParseX server running on http://localhost:3001
```

**Terminal 2 — start the frontend**

```powershell
cd parsex       # the root folder, not server/
npm run dev
# → Local: http://localhost:5173
```

Open your browser at **http://localhost:5173**.

---

## Switching AI Provider

Open `src/ParseX.jsx` and change one line:

```js
// Use Claude (Anthropic)
activeProvider: "claude"

// Use Gemini (Google) — current default
activeProvider: "gemini"

// Use GPT-4o (OpenAI) or GitHub Copilot
activeProvider: "openai"
```

The corresponding model name is set separately in **two places that must be kept in sync**:
- `server/index.js` → `ALLOWED_MODELS.<provider>` (the model actually called)
- `src/ParseX.jsx` → `providers.<provider>.model` (display label only)

For GitHub Copilot, add this to `server/.env`:

```env
OPENAI_KEY=your-copilot-token
OPENAI_BASE_URL=https://api.githubcopilot.com
```

> **A note on Gemini model names:** Google retires and renames Gemini models frequently — this project has moved through `gemini-1.5-flash` → `2.0-flash` → `2.5-flash` → `3.5-flash` → `3.1-flash-lite` over the course of a few months, each retirement causing a `404`. If you hit a 404 from `/api/gemini`, check which models your key can currently call:
> ```bash
> curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_GEMINI_KEY"
> ```
> Free-tier rate limits also vary a lot by model — heavier models like `3.5-flash` are capped as low as 5 requests/minute, while lightweight `flash-lite` variants allow up to 15 requests/minute. If you're hitting `429 Quota exceeded` errors, switching to a `-lite` model is usually the fix.

---

## How the AI Pipeline Works

```
Document uploaded
       │
       ▼
Multi-engine extraction
(PDF.js / mammoth.js / JSON recursive walker / plain text)
       │
       ▼
Smart text normalisation
(noise removal, boundary repair, citation stripping)
       │
       ▼
Is document > 8 KB?
       │
   YES │                          NO │
       ▼                             ▼
Map phase                      Single AI call
Split into overlapping         Summarise directly
8 KB chunks → summarise
each independently
       │
       ▼
Reduce phase
Synthesise all section
summaries into one
       │
       ▼
Final summary
       │
       ▼
Q&A generation
AI generates N question-answer
pairs from the summary
       │
       ▼
Results displayed
```

---

## Deployment

ParseX deploys as two separate services: the **frontend** on Vercel, the **backend** on Render. They don't share a build — each has its own repo root config.

### Backend → Render

1. [Render](https://render.com) → **New → Web Service** → connect this repo
2. **Root Directory:** `server`
3. **Build Command:** `npm install`
4. **Start Command:** `npm start`
5. **Environment variables:**
   ```env
   GEMINI_KEY=your-gemini-key
   ALLOWED_ORIGINS=https://your-frontend.vercel.app
   ```
   `ALLOWED_ORIGINS` must match your **production** Vercel URL exactly — no trailing slash, no `www.` mismatch. Vercel's per-commit preview URLs (e.g. `parse-x-git-abc123.vercel.app`) are *different origins* and will be rejected by CORS unless added too.
6. Render's free tier spins down after ~15 min idle and takes 30–50s to wake on the next request — expect a slow first request after inactivity.
7. Confirm it's live: `https://your-backend.onrender.com/health` should return `{ status: "ok", providers: {...} }`.

### Frontend → Vercel

1. [Vercel](https://vercel.com) → import this repo → Root Directory: repo root (not `server/`)
2. Build Command: `npm run build` · Output Directory: `dist` (Vercel auto-detects Vite)
3. **Environment variable:**
   ```env
   VITE_API_BASE_URL=https://your-backend.onrender.com
   ```
   This is required in production — Vite bakes it into the build at build time, so **changing it requires a redeploy** to take effect, not just a settings save. Without it, the frontend's `fetch()` calls use a relative `/api/...` path that only works locally via Vite's dev proxy, and will 404 in production.
4. Always test against your **Production** domain (Vercel dashboard → Settings → Domains), not the auto-generated per-commit preview link — the backend's CORS config only allows the production origin by default.

### Local dev vs. production request routing

| Environment | How `/api/...` calls are routed |
|---|---|
| Local (`npm run dev`) | Vite's dev proxy in `vite.config.js` forwards `/api/*` to whatever `target` URL is set there |
| Production (Vercel) | `PROVIDER_CONFIG.apiBase` (from `VITE_API_BASE_URL`) is prefixed onto every request, hitting Render directly |

---

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `ERESOLVE unable to resolve dependency tree` | Version mismatch in package.json | Use `"*"` for vite and plugin-react versions, delete node_modules and reinstall |
| `ANTHROPIC_KEY` / `GEMINI_KEY not configured` | Missing .env file or empty key | Copy .env.example to .env and add your key (local) or set it in Render's Environment tab (production) |
| `Could not reach API` / `Failed to fetch` | Backend not running, wrong `VITE_API_BASE_URL`, or Render service asleep | Check `/health` endpoint directly; confirm `VITE_API_BASE_URL` is set in Vercel and you've redeployed since setting it |
| `CORS error in browser` | Frontend origin not in `ALLOWED_ORIGINS` on Render | Set `ALLOWED_ORIGINS` to your exact production Vercel URL; remember preview-deploy URLs are different origins |
| `No open ports detected on 0.0.0.0` (Render build log) | Render's Root Directory points at the frontend instead of `server/` | Set Root Directory to `server`, Start Command to `npm start` |
| `models/gemini-... is not found` (404) | Google retired that model version | Check current models with `curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"` and update `ALLOWED_MODELS.gemini` in `server/index.js` |
| `Quota exceeded ... generate_content_free_tier_requests` (429) | Free-tier rate limit hit for that model | Switch to a `-flash-lite` variant for a higher free RPM cap, or add billing |
| `Failed to resolve import "json-repair"` | Wrong package name — the real npm package is `jsonrepair` (no hyphen) | Use `import { jsonrepair } from "jsonrepair"` and install `jsonrepair` in package.json |
| `Q&A response was not valid JSON` | AI returned malformed or markdown-wrapped response | Handled automatically via `jsonrepair` fallback; if it still fails, usually transient — try again |

---

## License

MIT — free to use, modify, and distribute.

---

## Author

Creator of **parseX** : **heykayy**
