# ParseX — Document Intelligence

> Hybrid AI document analyser. Precision multi-format extraction × AI-powered summarisation and Q&A generation.

![ParseX](https://img.shields.io/badge/ParseX-Document%20Intelligence-2563eb?style=for-the-badge)
![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react)
![Vite](https://img.shields.io/badge/Vite-latest-646cff?style=flat-square&logo=vite)
![Node.js](https://img.shields.io/badge/Node.js-Express-339933?style=flat-square&logo=node.js)

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
| Deployment | Vercel (frontend) · Railway / Render (backend) |

---

## Project Structure

```
parsex/
├── index.html              # HTML shell — React mounts here
├── package.json            # Frontend dependencies (React, Vite)
├── vite.config.js          # Vite config + dev proxy to backend
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
git clone https://github.com/your-username/parsex.git
cd parsex
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

In `src/ParseX.jsx`, find this line near the top of the `PROVIDER_CONFIG` object:

```js
activeProvider: "claude"   // change to "gemini" or "openai"
```

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

// Use Gemini (Google)
activeProvider: "gemini"

// Use GPT-4o (OpenAI) or GitHub Copilot
activeProvider: "openai"
```

For GitHub Copilot, add this to `server/.env`:

```env
OPENAI_KEY=your-copilot-token
OPENAI_BASE_URL=https://api.githubcopilot.com
```

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

### Frontend → Vercel

**Option A — via GitHub (recommended)**

1. Push your project to GitHub
2. Go to [vercel.com](https://vercel.com) and sign in
3. Click **Add New → Project**
4. Import your GitHub repository
5. Vercel auto-detects Vite — no build settings needed
6. Click **Deploy**

**Option B — via CLI**

```powershell
npm install -g vercel
vercel
```

Follow the prompts. Vercel detects Vite automatically.

---

### Backend → Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your repository, set the **root directory** to `server`
4. Add your environment variables in the Railway dashboard:
   - `ANTHROPIC_KEY`
   - `GEMINI_KEY` (if using)
   - `OPENAI_KEY` (if using)
   - `FRONTEND_URL` — set this to your Vercel URL e.g. `https://parsex.vercel.app`
5. Railway detects Node.js and deploys automatically

---

### Connect Frontend to Deployed Backend

Once your backend is deployed, you get a URL like `https://parsex-server.railway.app`.

Update `vite.config.js`:

```js
proxy: {
  "/api": {
    target: "https://parsex-server.railway.app",
    changeOrigin: true,
  },
},
```

Then redeploy the frontend to Vercel.

---

## Environment Variables Reference

### `server/.env`

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_KEY` | If using Claude | Get from console.anthropic.com |
| `GEMINI_KEY` | If using Gemini | Get from aistudio.google.com |
| `OPENAI_KEY` | If using GPT-4o / Copilot | Get from platform.openai.com |
| `OPENAI_BASE_URL` | Only for Copilot | `https://api.githubcopilot.com` |
| `PORT` | No | Defaults to 3001 |
| `FRONTEND_URL` | In production | Your Vercel deployment URL |

---

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `ERESOLVE unable to resolve dependency tree` | Version mismatch in package.json | Use `"*"` for vite and plugin-react versions, delete node_modules and reinstall |
| `ANTHROPIC_KEY not configured` | Missing .env file or empty key | Copy .env.example to .env and add your key |
| `Could not reach API` | Backend server not running | Start the server with `npm run dev` in the server/ folder |
| `CORS error in browser` | Frontend URL not in ALLOWED_ORIGINS | Add your frontend URL to ALLOWED_ORIGINS in server/index.js |
| `Q&A response was not valid JSON` | AI returned malformed response | Usually transient — try again; reduce Q&A count if it persists |

---

## License

MIT — free to use, modify, and distribute.

---

## Author

Built with React, Node.js, and multi-provider AI APIs.
