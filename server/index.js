/**
 * ParseX — Backend API Server
 * Proxies AI API calls so provider keys never reach the browser.
 *
 * Supported providers:
 *   POST /api/claude   → Anthropic Claude
 *   POST /api/gemini   → Google Gemini
 *   POST /api/openai   → OpenAI GPT / GitHub Copilot
 *   GET  /health       → liveness check
 */

import express   from "express";
import cors      from "cors";
import rateLimit from "express-rate-limit";
import dotenv    from "dotenv";

dotenv.config();

/* ─────────────────────────────────────────────────────────────────────────
   CONFIG
───────────────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3001;

// Provider API keys — set whichever ones you have in .env
const KEYS = {
  claude : process.env.ANTHROPIC_KEY,
  gemini : process.env.GEMINI_KEY,
  openai : process.env.OPENAI_KEY,
};

// Allowed models per provider — callers cannot request a different model
const ALLOWED_MODELS = {
  claude : "claude-sonnet-4-20250514",
  gemini : "gemini-2.5-flash",
  openai : "gpt-4o",
};

const MAX_TOKENS_CAP = 4000;

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : ["http://localhost:5173", "http://localhost:4173"]
).filter(Boolean);

/* ─────────────────────────────────────────────────────────────────────────
   STARTUP CHECK — warn if a key is missing (don't crash, just warn,
   so you can still use whichever providers you DO have keys for)
───────────────────────────────────────────────────────────────────────── */
for (const [name, key] of Object.entries(KEYS)) {
  if (!key) console.warn(`WARNING: ${name.toUpperCase()}_KEY not set — /api/${name} will return 503`);
}

/* ─────────────────────────────────────────────────────────────────────────
   EXPRESS SETUP
───────────────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: "2mb" }));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — wait 15 minutes and try again." },
});
app.use("/api/", limiter);

/* ─────────────────────────────────────────────────────────────────────────
   SHARED HELPERS
───────────────────────────────────────────────────────────────────────── */

/** Validate the messages array that every provider needs */
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0)
    return "messages must be a non-empty array.";
  for (const m of messages) {
    if (!m.role || !m.content)
      return "Each message must have a role and content.";
    if (!["user","assistant","system"].includes(m.role))
      return `Invalid role '${m.role}'.`;
  }
  return null;
}

/** Cap max_tokens safely */
function resolveMax(requested) {
  return Math.min(
    typeof requested === "number" && requested > 0 ? requested : 1000,
    MAX_TOKENS_CAP
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   HEALTH CHECK
───────────────────────────────────────────────────────────────────────── */
app.get("/health", (_req, res) => {
  res.json({
    status   : "ok",
    timestamp: new Date().toISOString(),
    providers: Object.fromEntries(
      Object.entries(KEYS).map(([k, v]) => [k, v ? "configured" : "missing"])
    ),
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/claude   (Anthropic)
   Request body: { model, max_tokens, system, messages }
   Docs: https://docs.anthropic.com/en/api/messages
───────────────────────────────────────────────────────────────────────── */
app.post("/api/claude", async (req, res) => {
  if (!KEYS.claude)
    return res.status(503).json({ error: "ANTHROPIC_KEY not configured on server." });

  const { messages, system, max_tokens } = req.body;
  const validationError = validateMessages(messages);
  if (validationError) return res.status(400).json({ error: validationError });

  const body = {
    model     : ALLOWED_MODELS.claude,
    max_tokens: resolveMax(max_tokens),
    messages,
    ...(system ? { system } : {}),
  };

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method : "POST",
      headers: {
        "Content-Type"     : "application/json",
        "x-api-key"        : KEYS.claude,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("Claude proxy error:", err.message);
    return res.status(502).json({ error: "Could not reach Anthropic API." });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/gemini   (Google)
   Request body: { model, systemInstruction, contents, generationConfig }
   Docs: https://ai.google.dev/api/generate-content
───────────────────────────────────────────────────────────────────────── */
app.post("/api/gemini", async (req, res) => {
  if (!KEYS.gemini)
    return res.status(503).json({ error: "GEMINI_KEY not configured on server." });

  const { contents, systemInstruction, generationConfig } = req.body;

  // contents is Gemini's equivalent of messages
  if (!Array.isArray(contents) || contents.length === 0)
    return res.status(400).json({ error: "contents must be a non-empty array." });

  const model = ALLOWED_MODELS.gemini;

  // Gemini's endpoint embeds the model name and key in the URL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEYS.gemini}`;

  const body = {
    ...(systemInstruction ? { systemInstruction } : {}),
    contents,
    generationConfig: {
      maxOutputTokens: resolveMax(generationConfig?.maxOutputTokens),
      temperature    : generationConfig?.temperature ?? 0.3,
    },
  };

  try {
    const upstream = await fetch(url, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("Gemini proxy error:", err.message);
    return res.status(502).json({ error: "Could not reach Google Gemini API." });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/openai   (OpenAI / GitHub Copilot)
   Request body: { model, max_tokens, temperature, messages }
   Docs: https://platform.openai.com/docs/api-reference/chat
   GitHub Copilot uses the same format at a different base URL — set
   OPENAI_BASE_URL=https://api.githubcopilot.com in .env to use Copilot.
───────────────────────────────────────────────────────────────────────── */
app.post("/api/openai", async (req, res) => {
  if (!KEYS.openai)
    return res.status(503).json({ error: "OPENAI_KEY not configured on server." });

  const { messages, max_tokens, temperature } = req.body;
  const validationError = validateMessages(messages);
  if (validationError) return res.status(400).json({ error: validationError });

  // Allow overriding the base URL for Copilot or Azure OpenAI
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";

  const body = {
    model      : ALLOWED_MODELS.openai,
    max_tokens : resolveMax(max_tokens),
    temperature: temperature ?? 0.3,
    messages,
  };

  try {
    const upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method : "POST",
      headers: {
        "Content-Type" : "application/json",
        "Authorization": `Bearer ${KEYS.openai}`,
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("OpenAI proxy error:", err.message);
    return res.status(502).json({ error: "Could not reach OpenAI API." });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   404 CATCH-ALL
───────────────────────────────────────────────────────────────────────── */
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found." });
});

/* ─────────────────────────────────────────────────────────────────────────
   START
───────────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\nParseX server running on http://localhost:${PORT}`);
  console.log(`Allowed origins : ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`Active providers:`);
  for (const [name, key] of Object.entries(KEYS)) {
    console.log(`  ${name.padEnd(8)} ${key ? "✓ key loaded" : "✗ key missing"}`);
  }
  console.log("");
});
