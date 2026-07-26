import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { jsonrepair } from "jsonrepair";


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════════════ */
const PDFJS_CDN    = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const MAMMOTH_CDN  = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
const CHUNK_SIZE   = 8000;
const OVERLAP      = 600;

const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,400&display=swap";

/* ═══════════════════════════════════════════════════════════════════════════
   PARSEX TEXT CLEANER  (ParseX's TextCleaner ported to JS)
═══════════════════════════════════════════════════════════════════════════ */

const PROTECTED_TERMS = [
  "DeepSeek","ChatGPT","OpenAI","FinTech","BofA","MoE","LLM","MLA",
  "LoRA","GPT","GPT-4","GPT-3","LLaMA","RLHF","SFT","RAG","BERT",
  "RoPE","GQA","FlashAttention","GitHub","LinkedIn","YouTube",
  "JavaScript","TypeScript","PyTorch","TensorFlow",
];

function parsexClean(text) {
  // Remove bullet/list markers
  text = text.replace(/[•●▪]/g, "");
  // Rejoin hyphenated line-breaks  (word-\nword → wordword)
  text = text.replace(/(\w+)-\s*\n\s*(\w+)/g, "$1$2");
  // Collapse whitespace early
  text = text.replace(/\s+/g, " ");

  // — placeholder masking (mirror ParseX's _mask logic) —
  const placeholders = {};
  let phIdx = 0;
  const mask = (token) => {
    const key = `\x01${phIdx++}\x01`;
    placeholders[key] = token;
    return key;
  };

  // Mask emails
  text = text.replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, (m) => mask(m));
  // Mask URLs
  text = text.replace(/https?:\/\/\S+/g, (m) => mask(m));
  // Mask protected terms (longest first to avoid partial matches)
  const sortedTerms = [...PROTECTED_TERMS].sort((a, b) => b.length - a.length);
  for (const term of sortedTerms) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    text = text.replace(re, (m) => mask(m));
  }

  // CamelCase split  e.g. "deepLearning" → "deep Learning"
  text = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  // Letter-digit boundaries
  text = text.replace(/([a-zA-Z])([\d])/g, "$1 $2");
  text = text.replace(/([\d%])([a-zA-Z])/g, "$1 $2");
  // Parenthesis spacing
  text = text.replace(/([a-zA-Z])\(/g, "$1 (");
  text = text.replace(/\)([a-zA-Z])/g, ") $1");
  // Sentence boundary spacing
  text = text.replace(/([.!?])([A-Z])/g, "$1 $2");
  // Comma spacing
  text = text.replace(/,([a-zA-Z])/g, ", $1");
  // Strip citation brackets  [1], [2,3]
  text = text.replace(/\[\d+(?:,\s*\d+)*\]/g, "");
  // Final whitespace normalise
  text = text.replace(/\s+/g, " ").trim();

  // Restore placeholders
  for (const [key, val] of Object.entries(placeholders)) {
    text = text.replaceAll(key, val);
  }

  return text;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARSEX FILE EXTRACTORS  (multi-engine, ParseX-faithful)
═══════════════════════════════════════════════════════════════════════════ */

async function loadPDFJS() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = PDFJS_CDN;
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; res(window.pdfjsLib); };
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function loadMammoth() {
  if (window.mammoth) return window.mammoth;
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = MAMMOTH_CDN;
    s.onload = () => res(window.mammoth);
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

/** PDF extraction — primary engine (PDF.js, mirrors pdfplumber) */
async function fromPDF(file, onPageProgress) {
  const pdfjs = await loadPDFJS();
  const buf   = await file.arrayBuffer();
  const pdf   = await pdfjs.getDocument({ data: buf }).promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Reconstruct text with whitespace-aware joining (mirrors pdfplumber behaviour)
    let lastX = null, lastY = null, line = "";
    const texts = [];
    for (const item of content.items) {
      if (!item.str) continue;
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
        if (line.trim()) texts.push(line.trim());
        line = item.str;
      } else {
        if (lastX !== null && item.transform[4] - lastX > 3) line += " ";
        line += item.str;
      }
      lastX = item.transform[4] + (item.width || 0);
      lastY = item.transform[5];
    }
    if (line.trim()) texts.push(line.trim());
    parts.push(texts.join(" "));
    onPageProgress && onPageProgress(i, pdf.numPages);
  }
  const combined = parts.join("\n");
  if (combined.trim().length < 100) throw new Error("PDF appears to be image-only (scanned). OCR is required but not available in the browser.");
  return combined;
}

/** DOCX extraction via mammoth.js (mirrors python-docx paragraph extraction) */
async function fromDOCX(file) {
  const mammoth = await loadMammoth();
  const buf     = await file.arrayBuffer();
  const result  = await mammoth.extractRawText({ arrayBuffer: buf });
  if (!result.value.trim()) throw new Error("Could not extract text from DOCX.");
  return result.value;
}

/** JSON extraction — recursive, mirrors ParseX's FileExtractor.from_json */
function extractJSONText(obj) {
  const texts = [];
  const walk = (node) => {
    if (typeof node === "string") { texts.push(node); }
    else if (Array.isArray(node)) { node.forEach(walk); }
    else if (node && typeof node === "object") { Object.values(node).forEach(walk); }
  };
  walk(obj);
  return texts.join("\n");
}

async function fromJSON(file) {
  const raw  = await file.text();
  try { return extractJSONText(JSON.parse(raw)); }
  catch { return raw; }
}

/** Plain text (TXT / MD / CSV) */
async function fromTXT(file) { return file.text(); }

/** Master extractor — routes by extension, mirrors FileExtractor.extract() */
async function extractFile(file, onPageProgress) {
  const ext = file.name.split(".").pop().toLowerCase();
  switch (ext) {
    case "pdf":  return fromPDF(file, onPageProgress);
    case "docx":
    case "doc":  return fromDOCX(file);
    case "json": return fromJSON(file);
    default:     return fromTXT(file);   // txt, md, csv
  }
}

/** Find content start — mirrors ParseX's _find_content_start (skip preamble in academic PDFs) */
function findContentStart(text) {
  const patterns = [/Abstract[:\s]/i, /1\.\s+Introduction/i, /^Abstract/im, /^Introduction/im];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return Math.max(0, m.index - 50);
  }
  return 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHUNKING  (DocAI sliding-window)
═══════════════════════════════════════════════════════════════════════════ */
function chunkText(text, size = CHUNK_SIZE, overlap = OVERLAP) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
    start += size - overlap;
  }
  return chunks;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MULTI-PROVIDER AI PIPELINE
   ─────────────────────────────────────────────────────────────────────────
   Supports: Claude (Anthropic) · Gemini (Google) · Copilot / GPT (OpenAI)

   HOW TO SWITCH PROVIDER
   ──────────────────────
   Change the single line at the bottom of PROVIDER_CONFIG:
     activeProvider: "claude"    ← switch to "gemini" or "openai"

   HOW TO ADD A NEW PROVIDER
   ─────────────────────────
   1. Add an entry to PROVIDER_CONFIG.providers
   2. Add a case to callAI() that handles its request/response shape
   That's it — buildSummary and buildQnA never change.

   ROUTING THROUGH YOUR BACKEND SERVER
   ────────────────────────────────────
   All three providers route through /api/<provider> on your Express server.
   The server holds the actual API keys. The frontend never sees them.
   See server/index.js for the corresponding proxy endpoints.
═══════════════════════════════════════════════════════════════════════════ */

const PROVIDER_CONFIG = {

  providers: {

    /* ── Anthropic Claude ──────────────────────────────────────────────── */
    claude: {
      label      : "Claude",          // display name shown in UI
      company    : "Anthropic",
      endpoint   : "/api/claude",     // hits server/index.js → Anthropic
      model      : "claude-sonnet-4-20250514",
      maxTokenCap: 4000,
    },

    /* ── Google Gemini ─────────────────────────────────────────────────── */
    gemini: {
      label      : "Gemini",
      company    : "Google",
      endpoint   : "/api/gemini",     // hits server/index.js → Google
      model      : "gemini-1.5-flash",
      maxTokenCap: 4000,
    },

    /* ── OpenAI (GPT-4o / GitHub Copilot uses the same OpenAI API) ─────── */
    openai: {
      label      : "GPT-4o",
      company    : "OpenAI",
      endpoint   : "/api/openai",     // hits server/index.js → OpenAI
      model      : "gpt-4o",
      maxTokenCap: 4000,
    },

  },

  // ← CHANGE THIS ONE LINE to switch provider across the whole app
  activeProvider: "gemini",
};

/* ─────────────────────────────────────────────────────────────────────────
   ACTIVE PROVIDER SHORTHAND
   Everything below reads from here — nothing else references PROVIDER_CONFIG
───────────────────────────────────────────────────────────────────────── */
const ACTIVE = PROVIDER_CONFIG.providers[PROVIDER_CONFIG.activeProvider];

/* ─────────────────────────────────────────────────────────────────────────
   callAI(userContent, systemPrompt, maxTokens)
   ─────────────────────────────────────────────
   Single entry point for all AI calls.
   Normalises the three different API shapes into one interface:
     - Claude  uses  { messages, system, max_tokens }  →  content[0].text
     - Gemini  uses  { contents, systemInstruction }   →  candidates[0].content.parts[0].text
     - OpenAI  uses  { messages (system as role) }     →  choices[0].message.content
   Returns a plain string in all cases.
───────────────────────────────────────────────────────────────────────── */
async function callAI(userContent, systemPrompt, maxTokens = 1200) {

  const provider   = PROVIDER_CONFIG.activeProvider;
  const config     = ACTIVE;
  const resolvedMax = Math.min(maxTokens, config.maxTokenCap);

  /* ── build the request body for each provider's expected shape ── */
  let body;

  if (provider === "claude") {
    // Anthropic format
    // docs: https://docs.anthropic.com/en/api/messages
    body = {
      model     : config.model,
      max_tokens: resolvedMax,
      system    : systemPrompt,
      messages  : [{ role: "user", content: userContent }],
    };
  }

  else if (provider === "gemini") {
    // Google Gemini format
    // docs: https://ai.google.dev/api/generate-content
    body = {
      model: config.model,
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [
        { role: "user", parts: [{ text: userContent }] },
      ],
      generationConfig: {
        maxOutputTokens: resolvedMax,
        temperature    : 0.3,
      },
    };
  }

  else if (provider === "openai") {
    // OpenAI Chat Completions format — also used by GitHub Copilot API
    // docs: https://platform.openai.com/docs/api-reference/chat
    body = {
      model      : config.model,
      max_tokens : resolvedMax,
      temperature: 0.3,
      messages   : [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userContent  },
      ],
    };
  }

  else {
    throw new Error(`Unknown provider "${provider}". Add it to PROVIDER_CONFIG.`);
  }

  /* ── send to your backend server (which holds the API key) ── */
  let res;
  try {
    res = await fetch(config.endpoint, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(body),
    });
  } catch (networkErr) {
    throw new Error(`Network error reaching ${config.label} server: ${networkErr.message}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Each provider puts the error message in a slightly different place
    const msg =
      err?.error?.message ||          // Claude + OpenAI
      err?.error?.status  ||          // Gemini
      `${config.label} API error ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();

  /* ── extract the text from each provider's response shape ── */
  if (provider === "claude") {
    return data.content?.[0]?.text || "";
  }

  if (provider === "gemini") {
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  if (provider === "openai") {
    return data.choices?.[0]?.message?.content || "";
  }

  return "";
}

/* ─────────────────────────────────────────────────────────────────────────
   MAP-REDUCE SUMMARISATION
   Uses callAI() — works with any provider without any changes here
───────────────────────────────────────────────────────────────────────── */
async function buildSummary(text, wordLimit, onProgress) {
  const chunks = chunkText(text);

  if (chunks.length === 1) {
    onProgress(1, 1, `Summarising with ${ACTIVE.label}…`);
    return callAI(
      `Summarise the following document in approximately ${wordLimit} words. Be clear, structured, and capture all key ideas:\n\n${chunks[0]}`,
      "You are an expert summarisation assistant. Output only the summary, no preamble.",
      Math.min(2000, wordLimit * 6)
    );
  }

  // Map phase — summarise each chunk independently
  const sectionSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(
      i + 1,
      chunks.length + 1,
      `Analysing section ${i + 1} of ${chunks.length} with ${ACTIVE.label}…`
    );
    const cs = await callAI(
      `Extract the key information from this section (≤120 words):\n\n${chunks[i]}`,
      "You are an expert document analyst. Output only key points, no preamble."
    );
    sectionSummaries.push(cs);
  }

  // Reduce phase — synthesise all section summaries into one
  onProgress(chunks.length + 1, chunks.length + 1, `Synthesising final summary…`);
  return callAI(
    `Below are section summaries of a large document. Synthesise them into one coherent summary of approximately ${wordLimit} words:\n\n${sectionSummaries.join("\n\n---\n\n")}`,
    "You are an expert summarisation assistant. Output only the synthesised summary, no preamble.",
    Math.min(2000, wordLimit * 6)
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Q&A GENERATION
   Uses callAI() — works with any provider without any changes here
───────────────────────────────────────────────────────────────────────── */
async function buildQnA(summary, qnaCount) {
  const raw = await callAI(
    `Based on the following document summary, generate exactly ${qnaCount} insightful Q&A pairs that test understanding of the document's core content.\n\nReturn ONLY a JSON array like:\n[{"question":"…","answer":"…"},…]\n\nNo markdown fences, no preamble.\n\nSummary:\n${summary}`,
    "You are an expert Q&A generator. Return only valid JSON, nothing else.",
    2000
  );

  // Strip any accidental markdown fences any provider might add
  const clean = raw.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Fall back to json-repair for malformed / markdown-wrapped JSON
    try {
      const safe = jsonrepair(clean);
      return JSON.parse(safe);
    } catch {
      throw new Error(`Q&A response from ${ACTIVE.label} was not valid JSON.`);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   THEME CONFIG  (DocAI system)
═══════════════════════════════════════════════════════════════════════════ */
const THEMES = {
  dark: {
    "--bg": "#07070f", "--bg2": "#0f0f1a", "--bg3": "#161625",
    "--border": "#1f1f35", "--border2": "#2a2a45",
    "--text": "#e8e8f5", "--text2": "#9090b8", "--text3": "#5a5a80",
    "--accent": "#2563eb", "--accent2": "#3b82f6", "--accent-bg": "#2563eb1a",
    "--grad-a": "#2563eb", "--grad-b": "#8b5cf6", "--grad-c": "#ec4899",
    "--gold": "#f0b429", "--gold-bg": "#f0b4291a",
    "--success": "#34d399", "--success-bg": "#34d3991a",
    "--danger": "#f87171", "--danger-bg": "#f871711a",
  },
  light: {
    "--bg": "#f4f4fc", "--bg2": "#ffffff", "--bg3": "#ececf8",
    "--border": "#dcdcee", "--border2": "#c8c8e0",
    "--text": "#0f0f1e", "--text2": "#4a4a6a", "--text3": "#8888aa",
    "--accent": "#2563eb", "--accent2": "#1d4ed8", "--accent-bg": "#2563eb1a",
    "--grad-a": "#2563eb", "--grad-b": "#8b5cf6", "--grad-c": "#ec4899",
    "--gold": "#d97706", "--gold-bg": "#d977061a",
    "--success": "#059669", "--success-bg": "#0596691a",
    "--danger": "#dc2626", "--danger-bg": "#dc26261a",
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   ICON HELPER
═══════════════════════════════════════════════════════════════════════════ */
const Icon = ({ d, size = 20, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={style}>
    <path d={d} />
  </svg>
);

const ic = {
  upload:   "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12",
  sun:      "M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 5a7 7 0 100 14A7 7 0 0012 5z",
  moon:     "M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z",
  monitor:  "M2 3h20a1 1 0 011 1v13a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011-1zM8 21h8M12 17v4",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
  close:    "M18 6L6 18M6 6l12 12",
  file:     "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  refresh:  "M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15",
  check:    "M20 6L9 17l-5-5",
  chevDown: "M6 9l6 6 6-6",
  chevUp:   "M18 15l-6-6-6 6",
  zap:      "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  copy:     "M8 17.929H6c-1.105 0-2-.912-2-2.036V5.036C4 3.91 4.895 3 6 3h8c1.105 0 2 .911 2 2.036v1.866m-6 .17h8c1.105 0 2 .91 2 2.035v10.857C20 21.09 19.105 22 18 22h-8c-1.105 0-2-.911-2-2.036V9.107c0-1.124.895-2.036 2-2.036z",
};

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════════════════ */
export default function ParseX() {
  /* settings */
  const [theme,        setTheme]        = useState("dark");
  const [layout,       setLayout]       = useState("comfortable");
  const [wordLimit,    setWordLimit]     = useState(300);
  const [qnaCount,     setQnaCount]     = useState(6);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* pipeline state */
  const [file,      setFile]      = useState(null);
  const [stage,     setStage]     = useState("idle");
  const [progStep,  setProgStep]  = useState({ current: 0, total: 0, label: "" });
  const [summary,   setSummary]   = useState("");
  const [qnas,      setQnas]      = useState([]);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [error,     setError]     = useState("");
  const [activeTab, setActiveTab] = useState("summary");
  const [expandedQ, setExpandedQ] = useState(null);
  const [copiedSum, setCopiedSum] = useState(false);
  const dropRef = useRef(null);

  /* resolved theme */
  const resolvedTheme = useMemo(() => {
    if (theme !== "system") return theme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }, [theme]);

  /* inject fonts */
  useEffect(() => {
    const link = document.createElement("link");
    link.rel  = "stylesheet";
    link.href = FONTS_URL;
    document.head.appendChild(link);
  }, []);

  /* apply CSS vars */
  useEffect(() => {
    const vars = THEMES[resolvedTheme];
    Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  }, [resolvedTheme]);

  /* drag-and-drop */
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    dropRef.current?.classList.remove("px-drag-over");
    const f = e.dataTransfer.files[0];
    if (f) runPipeline(f);
  }, [wordLimit, qnaCount]);

  const handleDragOver  = (e) => { e.preventDefault(); dropRef.current?.classList.add("px-drag-over"); };
  const handleDragLeave = ()  => { dropRef.current?.classList.remove("px-drag-over"); };

  /* ── main pipeline ─────────────────────────────────────────────────── */
  async function runPipeline(f) {
    const allowed = ["pdf","docx","doc","json","txt","md","csv"];
    const ext = f.name.split(".").pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setError(`Unsupported format ".${ext}". Accepted: ${allowed.join(", ")}`);
      return;
    }
    setFile(f); setStage("processing"); setError("");
    setSummary(""); setQnas([]); setActiveTab("summary"); setExpandedQ(null);

    try {
      // 1 — Extract  (ParseX multi-engine extractor)
      setProgStep({ current: 0, total: 5, label: "Extracting text…" });
      const raw = await extractFile(f, (cur, tot) =>
        setProgStep({ current: 0, total: 5, label: `Reading PDF page ${cur}/${tot}…` })
      );

      // 2 — Find content start  (ParseX academic header skip)
      setProgStep({ current: 1, total: 5, label: "Locating content boundary…" });
      const start   = findContentStart(raw);
      const trimmed = raw.slice(start);

      // 3 — Clean  (ParseX TextCleaner)
      setProgStep({ current: 2, total: 5, label: "Cleaning & normalising text…" });
      const cleaned = parsexClean(trimmed);
      setWordCount(cleaned.split(/\s+/).filter(Boolean).length);
      setCharCount(cleaned.length);
      if (cleaned.length < 50) throw new Error("Document appears empty or unreadable after extraction.");

      // 4 — Summarise  (DocAI Map-Reduce)
      setProgStep({ current: 3, total: 5, label: "Analysing document…" });
      const sum = await buildSummary(cleaned, wordLimit, (cur, tot, label) =>
        setProgStep({ current: 3, total: 5, label })
      );
      setSummary(sum);

      // 5 — Q&A  (DocAI generative)
      setProgStep({ current: 4, total: 5, label: `Generating ${qnaCount} Q&A pairs…` });
      const pairs = await buildQnA(sum, qnaCount);
      setQnas(pairs);

      setProgStep({ current: 5, total: 5, label: "Complete!" });
      setStage("done");
    } catch (err) {
      setError(err.message || "An unexpected error occurred.");
      setStage("error");
    }
  }

  const reset = () => {
    setFile(null); setStage("idle"); setSummary(""); setQnas([]);
    setError(""); setWordCount(0); setCharCount(0);
  };

  const copySum = () => {
    navigator.clipboard.writeText(summary).then(() => {
      setCopiedSum(true);
      setTimeout(() => setCopiedSum(false), 2000);
    });
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ file: file?.name, summary, qa_pairs: qnas }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `parsex_${file?.name?.replace(/\.[^.]+$/, "")}_analysis.json`; a.click();
  };

  const exportTXT = () => {
    let out = `ParseX Document Analysis\n${"=".repeat(50)}\n\nFile: ${file?.name}\n\nSUMMARY\n${"─".repeat(30)}\n${summary}\n\nQ&A PAIRS\n${"─".repeat(30)}\n`;
    qnas.forEach((q, i) => { out += `\nQ${i+1}: ${q.question}\nA:  ${q.answer}\n\n`; });
    const blob = new Blob([out], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `parsex_${file?.name?.replace(/\.[^.]+$/, "")}_analysis.txt`; a.click();
  };

  /* layout padding */
  const pad = { compact: "16px", comfortable: "28px", spacious: "44px" }[layout];
  const pct = progStep.total > 0 ? Math.round((progStep.current / progStep.total) * 100) : 0;

  /* ═══════════════════════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════════════════════ */
  return (
    <>
    <style>{`
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      :root { color-scheme: ${resolvedTheme}; }
      body  { background: var(--bg); }

      .px-root {
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: 'DM Sans', sans-serif;
        font-size: 15px; line-height: 1.6;
        transition: background .3s, color .3s;
      }

      /* ── ParseX gradient animation (retained from ParseX) ── */
      @keyframes px-shine {
        0%   { background-position: 0% center; }
        100% { background-position: 200% center; }
      }
      .px-brand-gradient {
        background: linear-gradient(90deg, var(--grad-a), var(--grad-b), var(--grad-c), var(--grad-b), var(--grad-a));
        background-size: 200% auto;
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        animation: px-shine 4s linear infinite;
      }

      /* ── header ── */
      .px-header {
        position: sticky; top: 0; z-index: 50;
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 28px;
        background: var(--bg2);
        border-bottom: 1px solid var(--border);
        backdrop-filter: blur(12px);
      }
      .px-logo { display: flex; align-items: center; gap: 10px; }
      .px-logo-icon {
        width: 34px; height: 34px; border-radius: 8px;
        background: linear-gradient(135deg, var(--grad-a), var(--grad-b));
        display: flex; align-items: center; justify-content: center;
        color: #fff; flex-shrink: 0;
      }
      .px-logo-text {
        font-family: 'Syne', sans-serif; font-weight: 800; font-size: 28px;
        letter-spacing: -0.5px;
      }
      .px-logo-sub {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 1.5px; color: var(--text3); margin-top: 2px;
        text-transform: uppercase;
      }
      .px-logo-content {
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .px-header-right { display: flex; align-items: center; gap: 8px; }

      .px-theme-grp {
        display: flex; align-items: center;
        background: var(--bg3); border: 1px solid var(--border);
        border-radius: 8px; padding: 3px; gap: 2px;
      }
      .px-theme-btn {
        padding: 5px 8px; border-radius: 6px; border: none; cursor: pointer;
        background: transparent; color: var(--text3);
        display: flex; align-items: center; transition: all .2s;
      }
      .px-theme-btn.active { background: var(--accent); color: #fff; }
      .px-theme-btn:hover:not(.active) { background: var(--border); color: var(--text); }

      .px-icon-btn {
        padding: 7px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg3);
        color: var(--text2); cursor: pointer;
        display: flex; align-items: center; transition: all .2s;
      }
      .px-icon-btn:hover { border-color: var(--accent); color: var(--accent); }

      /* ── settings panel ── */
      .px-overlay {
        position: fixed; inset: 0; z-index: 100;
        background: rgba(0,0,0,.55); backdrop-filter: blur(4px);
        animation: px-fade .2s;
      }
      @keyframes px-fade { from { opacity: 0; } to { opacity: 1; } }
      @keyframes px-slide { from { transform: translateX(100%); } to { transform: translateX(0); } }

      .px-settings-panel {
        position: fixed; right: 0; top: 0; bottom: 0; z-index: 101;
        width: min(380px, 95vw);
        background: var(--bg2); border-left: 1px solid var(--border);
        padding: 24px; overflow-y: auto;
        animation: px-slide .25s cubic-bezier(.22,1,.36,1);
      }
      .px-sett-hd {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 24px;
      }
      .px-sett-title {
        font-family: 'Syne', sans-serif; font-weight: 700; font-size: 18px;
      }
      .px-sett-close {
        padding: 6px; border-radius: 7px; border: 1px solid var(--border);
        background: var(--bg3); color: var(--text2); cursor: pointer;
        display: flex; align-items: center; transition: all .2s;
      }
      .px-sett-close:hover { color: var(--danger); border-color: var(--danger); }

      .px-sett-section {
        margin-bottom: 22px; padding-bottom: 22px;
        border-bottom: 1px solid var(--border);
      }
      .px-sett-section:last-child { border-bottom: none; margin-bottom: 0; }
      .px-sett-label {
        font-size: 11px; font-weight: 500; letter-spacing: 1px;
        text-transform: uppercase; color: var(--text3); margin-bottom: 10px;
      }
      .px-sett-val {
        font-family: 'IBM Plex Mono', monospace; font-size: 13px;
        color: var(--accent); margin-bottom: 8px; display: block;
      }
      input[type=range] {
        width: 100%; accent-color: var(--accent);
        height: 4px; border-radius: 4px; cursor: pointer;
      }
      .px-btn-grp { display: flex; gap: 8px; }
      .px-btn-opt {
        flex: 1; padding: 8px 10px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg3);
        color: var(--text2); font-size: 13px; cursor: pointer;
        font-family: 'DM Sans', sans-serif; transition: all .2s;
      }
      .px-btn-opt.active {
        border-color: var(--accent); background: var(--accent-bg); color: var(--accent);
      }

      /* ── main layout ── */
      .px-main {
        max-width: 880px; margin: 0 auto;
        padding: ${pad};
        padding-top: max(${pad}, 32px);
      }

      /* ── hero ── */
      .px-hero {
        text-align: center;
        padding: 20px 0 28px;
      }
      .px-hero-eyebrow {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 12px; border-radius: 20px;
        border: 1px solid var(--border2);
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        color: var(--text3); margin-bottom: 16px; letter-spacing: .8px;
        text-transform: uppercase; background: var(--bg2);
      }
      .px-hero-eyebrow span { color: var(--accent); }
      .px-hero h1 {
        font-family: 'Syne', sans-serif; font-weight: 800;
        font-size: clamp(28px, 5.5vw, 48px); letter-spacing: -1.5px;
        line-height: 1.05; margin-bottom: 14px;
      }
      .px-hero-sub {
        color: var(--text2); font-size: 15px;
        max-width: 520px; margin: 0 auto 28px; line-height: 1.65;
      }

      /* ── feature pills ── */
      .px-pills {
        display: flex; flex-wrap: wrap; gap: 8px;
        justify-content: center; margin-bottom: 32px;
      }
      .px-pill {
        padding: 5px 12px; border-radius: 20px;
        border: 1px solid var(--border2); background: var(--bg2);
        font-size: 12px; color: var(--text2);
        display: flex; align-items: center; gap: 5px;
      }
      .px-pill-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--accent); flex-shrink: 0;
      }
      .px-pill-dot.g { background: var(--success); }
      .px-pill-dot.y { background: var(--gold); }
      .px-pill-dot.p { background: #a78bfa; }

      /* ── dropzone ── */
      .px-dropzone {
        border: 2px dashed var(--border2);
        border-radius: 18px; padding: 52px 24px;
        text-align: center; cursor: pointer;
        transition: all .25s; background: var(--bg2);
        position: relative; overflow: hidden;
      }
      .px-dropzone::before {
        content: ''; position: absolute; inset: 0;
        background: radial-gradient(ellipse at 50% 0%, var(--accent-bg) 0%, transparent 70%);
        opacity: 0; transition: opacity .3s;
      }
      .px-dropzone:hover::before,
      .px-dropzone.px-drag-over::before { opacity: 1; }
      .px-dropzone:hover,
      .px-dropzone.px-drag-over {
        border-color: var(--accent); border-style: solid;
        transform: translateY(-2px);
        box-shadow: 0 12px 40px rgba(37,99,235,.1);
      }
      .px-dz-icon {
        width: 60px; height: 60px; border-radius: 16px;
        background: var(--accent-bg); border: 1px solid var(--accent);
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 16px; color: var(--accent);
        transition: transform .2s;
      }
      .px-dropzone:hover .px-dz-icon { transform: translateY(-3px) scale(1.05); }
      .px-dz-title {
        font-family: 'Syne', sans-serif; font-weight: 700; font-size: 18px;
        margin-bottom: 6px;
      }
      .px-dz-sub { color: var(--text2); font-size: 14px; margin-bottom: 22px; }
      .px-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
      .px-chip {
        padding: 4px 10px; border-radius: 20px;
        border: 1px solid var(--border2);
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        color: var(--text3); background: var(--bg3);
        letter-spacing: .5px; text-transform: uppercase;
      }
      .px-chip.hi { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }

      /* ── error banner ── */
      .px-error {
        background: var(--danger-bg); border: 1px solid var(--danger);
        border-radius: 12px; padding: 14px 18px;
        color: var(--danger); font-size: 14px;
        display: flex; align-items: flex-start; gap: 10px; margin-top: 16px;
      }
      .px-error-retry {
        margin-top: 10px; padding: 6px 14px; border-radius: 7px;
        border: 1px solid var(--danger); background: transparent;
        color: var(--danger); cursor: pointer; font-size: 13px;
        font-family: 'DM Sans', sans-serif; transition: all .2s;
      }
      .px-error-retry:hover { background: var(--danger); color: #fff; }

      /* ── inline user settings ── */
      .px-user-settings {
        background: var(--bg2); border: 1px solid var(--border);
        border-radius: 16px; padding: 20px 22px; margin-bottom: 20px;
        animation: px-up .35s ease;
      }
      .px-us-hd {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 18px;
      }
      .px-us-title {
        font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px;
        display: flex; align-items: center; gap: 7px; color: var(--text);
      }
      .px-us-title-icon {
        width: 22px; height: 22px; border-radius: 6px;
        background: var(--accent-bg); border: 1px solid var(--accent);
        display: flex; align-items: center; justify-content: center;
        color: var(--accent);
      }
      .px-us-hint {
        font-size: 11px; color: var(--text3);
        font-family: 'IBM Plex Mono', monospace; letter-spacing: .5px;
      }
      .px-us-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
      }
      @media(max-width:560px) { .px-us-grid { grid-template-columns: 1fr; } }
      .px-us-control {}
      .px-us-ctrl-hd {
        display: flex; align-items: baseline; justify-content: space-between;
        margin-bottom: 10px;
      }
      .px-us-ctrl-label {
        font-size: 12px; font-weight: 500; color: var(--text2); letter-spacing: .3px;
      }
      .px-us-ctrl-val {
        font-family: 'Syne', sans-serif; font-weight: 700; font-size: 18px;
        color: var(--accent); line-height: 1;
      }
      .px-us-ctrl-unit {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        color: var(--text3); margin-left: 3px; font-weight: 400;
      }
      /* preset chips row */
      .px-presets {
        display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px;
      }
      .px-preset {
        padding: 4px 11px; border-radius: 20px; border: 1px solid var(--border2);
        background: var(--bg3); color: var(--text3);
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        cursor: pointer; transition: all .18s; white-space: nowrap;
      }
      .px-preset:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
      .px-preset.sel   { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); font-weight: 500; }
      /* slider track */
      .px-us-slider { width: 100%; accent-color: var(--accent); height: 4px; border-radius: 4px; cursor: pointer; }
      .px-us-slider-row {
        display: flex; align-items: center; gap: 8px;
      }
      .px-us-slider-row input { flex: 1; }
      .px-us-range-labels {
        display: flex; justify-content: space-between;
        margin-top: 4px; font-size: 10px; color: var(--text3);
        font-family: 'IBM Plex Mono', monospace;
      }
      .px-us-divider {
        height: 1px; background: var(--border); margin: 18px 0 0;
      }
      .px-us-summary-row {
        display: flex; align-items: center; gap: 12px;
        padding-top: 14px; flex-wrap: wrap;
      }
      .px-us-summary-chip {
        display: flex; align-items: center; gap: 6px;
        padding: 5px 12px; border-radius: 20px;
        border: 1px solid var(--border); background: var(--bg3);
        font-size: 12px; color: var(--text2);
      }
      .px-us-summary-chip strong {
        font-family: 'Syne', sans-serif; font-weight: 700; color: var(--accent);
      }
      .px-us-summary-note {
        font-size: 11px; color: var(--text3); margin-left: auto;
        font-family: 'IBM Plex Mono', monospace;
      }

      /* ── pipeline engine cards ── */
      .px-engines {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(190px,1fr));
        gap: 10px; margin-top: 28px;
      }
      .px-engine-card {
        background: var(--bg2); border: 1px solid var(--border);
        border-radius: 12px; padding: 14px 16px;
      }
      .px-engine-dot {
        width: 7px; height: 7px; border-radius: 50%; margin-bottom: 8px;
      }
      .px-engine-name {
        font-family: 'Syne', sans-serif; font-weight: 700;
        font-size: 12.5px; margin-bottom: 4px;
      }
      .px-engine-desc {
        font-size: 11.5px; color: var(--text2); line-height: 1.5;
      }

      /* ── processing ── */
      .px-processing { padding: 56px 24px; text-align: center; }
      @keyframes px-pulse {
        0%,100% { box-shadow: 0 0 0 0 var(--accent-bg); }
        50%      { box-shadow: 0 0 0 20px transparent; }
      }
      .px-proc-icon {
        width: 68px; height: 68px; border-radius: 18px;
        background: var(--accent-bg); border: 1px solid var(--accent);
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 20px; color: var(--accent);
        animation: px-pulse 2s ease-in-out infinite;
      }
      .px-proc-title {
        font-family: 'Syne', sans-serif; font-weight: 700; font-size: 22px;
        margin-bottom: 6px;
      }
      .px-proc-sub {
        color: var(--text2); font-size: 14px; margin-bottom: 28px; min-height: 22px;
      }
      .px-prog-track {
        width: 100%; max-width: 420px; margin: 0 auto 10px;
        height: 6px; border-radius: 6px;
        background: var(--bg3); overflow: hidden; border: 1px solid var(--border);
      }
      .px-prog-fill {
        height: 100%; border-radius: 6px;
        background: linear-gradient(90deg, var(--grad-a), var(--grad-b), var(--grad-c));
        transition: width .5s cubic-bezier(.4,0,.2,1);
        background-size: 200% auto;
        animation: px-shine 2s linear infinite;
      }
      .px-proc-pct {
        font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--text3);
      }
      .px-proc-file {
        margin-top: 20px; font-size: 12px; color: var(--text3);
        font-family: 'IBM Plex Mono', monospace;
      }

      /* ── results ── */
      @keyframes px-up {
        from { opacity: 0; transform: translateY(10px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .px-file-bar {
        display: flex; align-items: center; gap: 12px;
        padding: 12px 16px; border-radius: 12px;
        background: var(--bg2); border: 1px solid var(--border);
        margin-bottom: 18px;
      }
      .px-file-icon { color: var(--accent); flex-shrink: 0; }
      .px-file-info { flex: 1; min-width: 0; }
      .px-file-name {
        font-weight: 500; font-size: 14px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .px-file-meta {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        color: var(--text3); margin-top: 3px;
      }
      .px-new-btn {
        padding: 7px 14px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg3);
        color: var(--text2); font-size: 13px; cursor: pointer;
        display: flex; align-items: center; gap: 6px;
        font-family: 'DM Sans', sans-serif; transition: all .2s; white-space: nowrap;
      }
      .px-new-btn:hover { border-color: var(--accent); color: var(--accent); }

      /* ── stats ── */
      .px-stats { display: flex; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
      .px-stat {
        flex: 1; min-width: 100px;
        background: var(--bg2); border: 1px solid var(--border);
        border-radius: 10px; padding: 12px 14px;
      }
      .px-stat-val {
        font-family: 'Syne', sans-serif; font-weight: 800; font-size: 22px;
        color: var(--accent);
      }
      .px-stat-label { font-size: 11.5px; color: var(--text3); margin-top: 2px; }

      /* ── tabs ── */
      .px-tabs {
        display: flex; gap: 4px;
        background: var(--bg2); border: 1px solid var(--border);
        border-radius: 10px; padding: 4px; margin-bottom: 18px;
      }
      .px-tab {
        flex: 1; padding: 9px; border-radius: 7px; border: none;
        background: transparent; cursor: pointer;
        font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500;
        color: var(--text2); transition: all .2s;
        display: flex; align-items: center; justify-content: center; gap: 7px;
      }
      .px-tab.active { background: var(--accent); color: #fff; }
      .px-tab:not(.active):hover { background: var(--bg3); color: var(--text); }
      .px-badge {
        padding: 1px 7px; border-radius: 20px;
        font-size: 11px; font-family: 'IBM Plex Mono', monospace;
      }
      .px-tab.active .px-badge { background: rgba(255,255,255,.25); }
      .px-tab:not(.active) .px-badge { background: var(--border); color: var(--text3); }

      /* ── summary card ── */
      .px-card {
        background: var(--bg2); border: 1px solid var(--border);
        border-radius: 16px; padding: 24px;
        animation: px-up .4s ease;
      }
      .px-card-hd {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 16px; flex-wrap: wrap; gap: 10px;
      }
      .px-card-title {
        font-family: 'Syne', sans-serif; font-weight: 700; font-size: 15px;
        display: flex; align-items: center; gap: 8px;
      }
      @keyframes px-blink { 0%,100%{opacity:1} 50%{opacity:.25} }
      .px-live-dot {
        width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
        animation: px-blink 2s step-end infinite;
      }
      .px-card-actions { display: flex; gap: 8px; }
      .px-action-btn {
        padding: 5px 10px; border-radius: 7px;
        border: 1px solid var(--border); background: var(--bg3);
        color: var(--text2); font-size: 12px; cursor: pointer;
        font-family: 'DM Sans', sans-serif; transition: all .2s;
        display: flex; align-items: center; gap: 5px;
      }
      .px-action-btn:hover { border-color: var(--accent); color: var(--accent); }
      .px-wc-tag {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        color: var(--text3); padding: 3px 8px;
        border-radius: 20px; border: 1px solid var(--border); background: var(--bg3);
      }
      .px-summary-text {
        font-size: 15px; line-height: 1.8; color: var(--text); white-space: pre-wrap;
      }

      /* ── export row ── */
      .px-export-row {
        display: flex; gap: 8px; margin-top: 20px; padding-top: 20px;
        border-top: 1px solid var(--border); flex-wrap: wrap;
      }
      .px-export-btn {
        padding: 8px 16px; border-radius: 8px;
        border: 1px solid var(--border); background: var(--bg3);
        color: var(--text2); font-size: 13px; cursor: pointer;
        font-family: 'DM Sans', sans-serif; transition: all .2s;
        display: flex; align-items: center; gap: 6px;
      }
      .px-export-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }

      /* ── Q&A ── */
      .px-qna-list { display: flex; flex-direction: column; gap: 10px; }
      .px-qna-item {
        background: var(--bg2); border: 1px solid var(--border);
        border-radius: 12px; overflow: hidden;
        animation: px-up .4s ease both; transition: border-color .2s;
      }
      .px-qna-item:hover { border-color: var(--border2); }
      .px-qna-item.open  { border-color: var(--accent); }
      .px-qna-q {
        display: flex; align-items: flex-start; gap: 12px;
        padding: 16px 18px; cursor: pointer;
      }
      .px-qna-num {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        color: var(--accent); background: var(--accent-bg);
        border: 1px solid var(--accent); border-radius: 5px;
        padding: 2px 7px; flex-shrink: 0; margin-top: 1px;
      }
      .px-qna-q-text {
        flex: 1; font-weight: 500; font-size: 14px; line-height: 1.55;
      }
      .px-qna-chev {
        color: var(--text3); flex-shrink: 0; margin-top: 2px;
        transition: transform .25s;
      }
      .px-qna-item.open .px-qna-chev { transform: rotate(180deg); }
      .px-qna-a {
        padding: 0 18px 16px 52px;
        font-size: 14px; line-height: 1.7; color: var(--text2); display: none;
      }
      .px-qna-item.open .px-qna-a { display: block; }
      .px-a-label {
        font-size: 11px; letter-spacing: .7px; text-transform: uppercase;
        color: var(--gold); font-weight: 500; margin-bottom: 6px;
        display: flex; align-items: center; gap: 5px;
      }

      /* ── scrollbar ── */
      ::-webkit-scrollbar { width: 5px; }
      ::-webkit-scrollbar-track { background: var(--bg); }
      ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 5px; }

      @media (max-width: 600px) {
        .px-header { padding: 12px 16px; }
        .px-main { padding: 16px; }
      }
    `}</style>

    <div className="px-root">

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <header className="px-header">
        <div className="px-logo">

          <div className="px-logo-content">
            <div className="px-logo-text">
              <span className="px-brand-gradient">X</span>
            </div>
            <div className="px-logo-sub">Document Intelligence</div>
          </div>
        </div>

        <div className="px-header-right">
          <div className="px-theme-grp">
            {[{id:"light",icon:ic.sun},{id:"system",icon:ic.monitor},{id:"dark",icon:ic.moon}].map(({id,icon})=>(
              <button key={id} className={`px-theme-btn ${theme===id?"active":""}`}
                onClick={()=>setTheme(id)} title={id}>
                <Icon d={icon} size={14} />
              </button>
            ))}
          </div>
          <button className="px-icon-btn" onClick={()=>setSettingsOpen(true)} title="Settings">
            <Icon d={ic.settings} size={16} />
          </button>
        </div>
      </header>

      {/* ── SETTINGS PANEL ─────────────────────────────────────────────── */}
      {settingsOpen && (
        <>
          <div className="px-overlay" onClick={()=>setSettingsOpen(false)} />
          <aside className="px-settings-panel">
            <div className="px-sett-hd">
              <span className="px-sett-title">Settings</span>
              <button className="px-sett-close" onClick={()=>setSettingsOpen(false)}>
                <Icon d={ic.close} size={15} />
              </button>
            </div>

            <div className="px-sett-section">
              <div className="px-sett-label">Page Layout</div>
              <div className="px-btn-grp">
                {["compact","comfortable","spacious"].map(l=>(
                  <button key={l} className={`px-btn-opt ${layout===l?"active":""}`} onClick={()=>setLayout(l)}>
                    {l.charAt(0).toUpperCase()+l.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-sett-section">
              <div className="px-sett-label">Color Theme</div>
              <div className="px-btn-grp">
                {["light","dark","system"].map(t=>(
                  <button key={t} className={`px-btn-opt ${theme===t?"active":""}`} onClick={()=>setTheme(t)}>
                    {t.charAt(0).toUpperCase()+t.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Pipeline info */}
            <div className="px-sett-section" style={{paddingBottom:0,borderBottom:"none"}}>
              <div className="px-sett-label">Active Pipeline</div>
              {[
                {label:"Extraction", val:"Multi-format · PDF, DOCX, JSON, MD, CSV, TXT",       color:"var(--accent)"},
                {label:"Cleaning",   val:"Smart normalisation · noise removal · text repair",   color:"var(--gold)"},
                {label:"Summary",    val:`${ACTIVE.label} Map-Reduce · ${ACTIVE.company}`,      color:"var(--success)"},
                {label:"Q&A",        val:`${ACTIVE.label} generative · ${ACTIVE.company}`,      color:"#a78bfa"},
              ].map(({label,val,color})=>(
                <div key={label} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:10}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:color,marginTop:5,flexShrink:0}} />
                  <div>
                    <div style={{fontSize:12,fontWeight:500,color:"var(--text)"}}>{label}</div>
                    <div style={{fontSize:11,color:"var(--text3)",fontFamily:"'IBM Plex Mono',monospace",marginTop:1}}>{val}</div>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </>
      )}

      {/* ── MAIN ──────────────────────────────────────────────────────── */}
      <main className="px-main">

        {/* ── IDLE ── */}
        {stage === "idle" && (
          <>
            <div className="px-hero">
              <div className="px-hero-eyebrow">
                <Icon d={ic.zap} size={12} style={{color:"var(--accent)"}} />
                <span>Hybrid AI Pipeline</span>
                <span style={{color:"var(--text3)"}}>·</span>
                <span>Precision extraction × {ACTIVE.label} intelligence</span>
              </div>
              <h1>
                <span>Parse</span><span className="px-brand-gradient">X</span>
              </h1>
              <p className="px-hero-sub">
                ParseX extracts and cleans every format with precision, then
                summarises the whole document and generate smart Q&amp;A pairs.
              </p>
            </div>

            {/* Feature pills */}
            <div className="px-pills">
              {[
                {dot:"",  text:"Multi-format extraction"},
                {dot:"y", text:"Smart text normalisation"},
                {dot:"p", text:`Map-Reduce summarisation · ${ACTIVE.label}`},
                {dot:"",  text:`Generative Q&A · ${ACTIVE.company}`},
                {dot:"g", text:"PDF · DOCX · JSON · MD · CSV · TXT"},
              ].map(({dot,text})=>(
                <div key={text} className="px-pill">
                  <span className={`px-pill-dot ${dot}`} />
                  {text}
                </div>
              ))}
            </div>

            {/* ── Inline User Settings ── */}
            <div className="px-user-settings">
              <div className="px-us-hd">
                <div className="px-us-title">
                  <div className="px-us-title-icon">
                    <Icon d={ic.settings} size={12} />
                  </div>
                  Output Settings
                </div>
                <span className="px-us-hint">set before uploading your document</span>
              </div>

              <div className="px-us-grid">
                {/* — Summary length — */}
                <div className="px-us-control">
                  <div className="px-us-ctrl-hd">
                    <span className="px-us-ctrl-label">Summary Length</span>
                    <span>
                      <span className="px-us-ctrl-val">{wordLimit}</span>
                      <span className="px-us-ctrl-unit">words</span>
                    </span>
                  </div>
                  <div className="px-presets">
                    {[100,200,300,500,750,1000].map(v=>(
                      <button key={v}
                        className={`px-preset ${wordLimit===v?"sel":""}`}
                        onClick={()=>setWordLimit(v)}>
                        {v}w
                      </button>
                    ))}
                  </div>
                  <div className="px-us-slider-row">
                    <input type="range" className="px-us-slider"
                      min={100} max={1000} step={50} value={wordLimit}
                      onChange={e=>setWordLimit(Number(e.target.value))} />
                  </div>
                  <div className="px-us-range-labels"><span>100</span><span>550</span><span>1000</span></div>
                </div>

                {/* — Q&A count — */}
                <div className="px-us-control">
                  <div className="px-us-ctrl-hd">
                    <span className="px-us-ctrl-label">Q&amp;A Pairs</span>
                    <span>
                      <span className="px-us-ctrl-val">{qnaCount}</span>
                      <span className="px-us-ctrl-unit">pairs</span>
                    </span>
                  </div>
                  <div className="px-presets">
                    {[3,5,8,10,15,20].map(v=>(
                      <button key={v}
                        className={`px-preset ${qnaCount===v?"sel":""}`}
                        onClick={()=>setQnaCount(v)}>
                        {v}
                      </button>
                    ))}
                  </div>
                  <div className="px-us-slider-row">
                    <input type="range" className="px-us-slider"
                      min={3} max={20} step={1} value={qnaCount}
                      onChange={e=>setQnaCount(Number(e.target.value))} />
                  </div>
                  <div className="px-us-range-labels"><span>3</span><span>11</span><span>20</span></div>
                </div>
              </div>

              {/* Live summary row */}
              <div className="px-us-divider" />
              <div className="px-us-summary-row">
                <div className="px-us-summary-chip">
                  Summary: <strong>{wordLimit}</strong>&nbsp;words
                </div>
                <div className="px-us-summary-chip">
                  Q&amp;A: <strong>{qnaCount}</strong>&nbsp;pairs
                </div>
                <span className="px-us-summary-note">
                  powered by {ACTIVE.label} · {ACTIVE.company} · large docs use map-reduce
                </span>
              </div>
            </div>

            {/* Drop zone */}
            <div
              ref={dropRef}
              className="px-dropzone"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={()=>document.getElementById("px-file-in").click()}
            >
              <div className="px-dz-icon">
                <Icon d={ic.upload} size={28} />
              </div>
              <div className="px-dz-title">Drop your document here</div>
              <div className="px-dz-sub">or click to browse — PDF, DOCX, JSON, TXT, MD, CSV</div>
              <div className="px-chips">
                {["PDF","DOCX","JSON","TXT","MD","CSV"].map((t,i)=>(
                  <span key={t} className={`px-chip ${i<2?"hi":""}`}>{t}</span>
                ))}
              </div>
            </div>
            <input id="px-file-in" type="file" style={{display:"none"}}
              accept=".pdf,.docx,.doc,.json,.txt,.md,.csv"
              onChange={e=>e.target.files[0]&&runPipeline(e.target.files[0])} />

            {error && (
              <div className="px-error"><span>{error}</span></div>
            )}

            {/* Engine cards */}
            <div className="px-engines">
              {[
                {color:"var(--accent)", name:"Multi-Format Extraction",    desc:"Handles PDF, DOCX, JSON, Markdown, CSV and plain text — with layout-aware text reconstruction for accurate results."},
                {color:"var(--gold)",   name:"Smart Text Normalisation",    desc:"Removes noise, rejoins broken words, splits run-together text, strips citations — before any AI sees it."},
                {color:"var(--success)",name:"Map-Reduce Summarisation",    desc:`Splits large documents into overlapping sections, summarises each independently, then ${ACTIVE.label} synthesises a final coherent summary.`},
                {color:"#a78bfa",       name:`${ACTIVE.label} Q&A Engine`,  desc:`Generates ${ACTIVE.label} (${ACTIVE.company}) powered Q&A pairs from the full document summary — full-sentence, context-aware answers.`},
              ].map(({color,name,desc})=>(
                <div key={name} className="px-engine-card">
                  <div className="px-engine-dot" style={{background:color}} />
                  <div className="px-engine-name">{name}</div>
                  <div className="px-engine-desc">{desc}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── PROCESSING ── */}
        {stage === "processing" && (
          <div className="px-processing">
            <div className="px-proc-icon">
              <Icon d={ic.zap} size={30} />
            </div>
            <div className="px-proc-title">
              <span className="px-brand-gradient">ParseX</span> is analysing
            </div>
            <div className="px-proc-sub">{progStep.label}</div>
            <div className="px-prog-track">
              <div className="px-prog-fill" style={{width:`${pct}%`}} />
            </div>
            <div className="px-proc-pct">{pct}%</div>
            {file && (
              <div className="px-proc-file">
                <Icon d={ic.file} size={12} style={{verticalAlign:"middle",marginRight:5}} />
                {file.name}
              </div>
            )}
          </div>
        )}

        {/* ── ERROR ── */}
        {stage === "error" && (
          <div style={{padding:"32px 0"}}>
            <div className="px-error">
              <div>
                <strong>Analysis failed</strong><br/>{error}
                <div>
                  <button className="px-error-retry" onClick={reset}>
                    <Icon d={ic.refresh} size={13} style={{verticalAlign:"middle",marginRight:5}} />
                    Try another file
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── DONE ── */}
        {stage === "done" && (
          <>
            {/* File bar */}
            <div className="px-file-bar">
              <div className="px-file-icon"><Icon d={ic.file} size={20} /></div>
              <div className="px-file-info">
                <div className="px-file-name">{file?.name}</div>
                <div className="px-file-meta">
                  {(file?.size/1024).toFixed(1)} KB
                  &nbsp;·&nbsp; {wordCount.toLocaleString()} words
                  &nbsp;·&nbsp; {charCount.toLocaleString()} chars
                </div>
              </div>
              <button className="px-new-btn" onClick={reset}>
                <Icon d={ic.refresh} size={14} /> New file
              </button>
            </div>

            {/* Stats */}
            <div className="px-stats">
              {[
                {label:"Document Words", val:wordCount.toLocaleString()},
                {label:"Characters",     val:charCount.toLocaleString()},
                {label:"Summary Words",  val:summary.split(/\s+/).filter(Boolean).length},
                {label:"Q&A Pairs",      val:qnas.length},
              ].map(({label,val})=>(
                <div className="px-stat" key={label}>
                  <div className="px-stat-val">{val}</div>
                  <div className="px-stat-label">{label}</div>
                </div>
              ))}
            </div>

            {/* Tabs */}
            <div className="px-tabs">
              <button className={`px-tab ${activeTab==="summary"?"active":""}`} onClick={()=>setActiveTab("summary")}>
                Summary
                <span className="px-badge">{summary.split(/\s+/).filter(Boolean).length}w</span>
              </button>
              <button className={`px-tab ${activeTab==="qna"?"active":""}`} onClick={()=>setActiveTab("qna")}>
                Q&amp;A Pairs
                <span className="px-badge">{qnas.length}</span>
              </button>
            </div>

            {/* Summary tab */}
            {activeTab === "summary" && (
              <div className="px-card">
                <div className="px-card-hd">
                  <div className="px-card-title">
                    <span className="px-live-dot" />
                    Document Summary
                  </div>
                  <div className="px-card-actions">
                    <button className="px-action-btn" onClick={copySum}>
                      <Icon d={copiedSum?ic.check:ic.copy} size={13} />
                      {copiedSum?"Copied":"Copy"}
                    </button>
                    <span className="px-wc-tag">{summary.split(/\s+/).filter(Boolean).length} words</span>
                  </div>
                </div>
                <div className="px-summary-text">{summary}</div>
                <div className="px-export-row">
                  <button className="px-export-btn" onClick={exportJSON}>
                    <Icon d={ic.download} size={14} /> Export JSON
                  </button>
                  <button className="px-export-btn" onClick={exportTXT}>
                    <Icon d={ic.download} size={14} /> Export TXT
                  </button>
                </div>
              </div>
            )}

            {/* Q&A tab */}
            {activeTab === "qna" && (
              <div className="px-qna-list">
                {qnas.map((qa, i) => (
                  <div
                    key={i}
                    className={`px-qna-item ${expandedQ===i?"open":""}`}
                    style={{animationDelay:`${i*45}ms`}}
                  >
                    <div className="px-qna-q" onClick={()=>setExpandedQ(expandedQ===i?null:i)}>
                      <span className="px-qna-num">Q{String(i+1).padStart(2,"0")}</span>
                      <span className="px-qna-q-text">{qa.question}</span>
                      <span className="px-qna-chev">
                        <Icon d={expandedQ===i?ic.chevUp:ic.chevDown} size={16} />
                      </span>
                    </div>
                    <div className="px-qna-a">
                      <div className="px-a-label">
                        <Icon d={ic.check} size={11} /> Answer
                      </div>
                      {qa.answer}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

      </main>
    </div>
    </>
  );
}
