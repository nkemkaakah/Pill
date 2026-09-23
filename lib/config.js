'use strict';
// Settings live in one JSON file inside Electron's userData dir.
// Nothing here ever leaves the machine except what you send to your model provider.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Which API answers questions: 'anthropic' (Claude, native Messages API) or
  // 'openai' (OpenAI, or anything OpenAI-compatible: Ollama, LM Studio, OpenRouter...).
  provider: 'anthropic',

  // Anthropic. Two chat models: "fast" is the default, "smart" is behind the toggle.
  anthropicApiKey: '',
  anthropicBaseUrl: 'https://api.anthropic.com',
  // Haiku answers a "what did they just ask?" mid-call in a fraction of the time and
  // roughly half the cost of Sonnet; the smart toggle is there for the hard ones.
  anthropicFastModel: 'claude-haiku-4-5',
  anthropicSmartModel: 'claude-sonnet-5',

  // OpenAI-compatible. `apiKey` is the OpenAI key; it is also what transcription uses.
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  fastModel: 'gpt-5.6-luna',
  smartModel: 'gpt-5.6-terra',

  // Google Gemini, through its OpenAI-compatible endpoint (ai.google.dev/gemini-api/docs/openai).
  // Keys come from aistudio.google.com/apikey. 3.5 Flash-Lite is the cheap default;
  // 3.8 Flash is the strongest stable model (3.1 Pro is still preview-only).
  geminiApiKey: '',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  geminiFastModel: 'gemini-3.5-flash-lite',
  geminiSmartModel: 'gemini-3.8-flash',

  reasoningEffort: 'low', // none | low | medium | high  (sent only to models that accept it)
  maxOutputTokens: 4096,

  // Live transcription. Runs locally through the streaming sidecar — no key, no
  // per-minute cost. English only (the streaming model is English-only).
  sttEnabled: true,
  streamChunkMs: 320,       // parakeet-stream window: 160 (lowest latency) | 320 | 1280
  eouDebounceMs: 1280,      // silence before an utterance is closed and emitted as final
  sttStableMs: 1500,        // fallback: close an utterance if the words stop changing
                            // for this long, even when end-of-utterance never fires

  // Behaviour
  invisible: true,          // setContentProtection — hidden from screen share / recording
  attachScreenshot: true,   // every question carries a fresh screenshot by default
  screenshotMaxWidth: 1600,
  // Local engine (FluidAudio sidecar)
  localRefine: true,           // after Stop, rebuild the transcript locally with speaker labels
  sidecarPath: '',             // custom path to fluidaudiocli (blank = auto-detect)
  audioteePath: '',            // custom path to the audiotee system-audio tap (blank = auto-detect)

  // Optional cloud pass for the transcript of record. Never automatic — it bills per
  // second of audio, per channel (~$0.52 for a 1-hour two-channel call).
  deepgramApiKey: '',
  cloudLanguage: 'en',         // cloud pass only; the local models are English-only

  // Context document — one flat file (userData/context.md, owned by lib/context.js).
  // Only this small metadata lives in config; the content itself never does.
  contextDocName: '',
  contextDocChars: 0,
  contextDocUploadedAt: 0,

  // DeepSeek via OpenRouter. OpenAI-compatible, so it reuses provider.chat('openai', ...)
  // with these credentials swapped in — see lib/route.js. Only ever used for
  // screenshot-free questions, and only when a key is set (never a silent default).
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://openrouter.ai/api/v1',
  deepseekFastModel: 'deepseek/deepseek-v3.2',
  deepseekSmartModel: 'deepseek/deepseek-v3.2',
  speakerMatchThreshold: 0.45, // cosine similarity needed to auto-name a voice
  shortcuts: {},               // overrides of DEFAULT_SHORTCUTS, name -> accelerator
  transcriptWindowMinutes: 10, // "recent" transcript context for typed questions
  transcriptScope: 'recent',   // 'recent' | 'all' — what typed questions get. Recap and notes always get all.
  autoRecord: false,           // start recording as soon as Pill launches
  panelSize: 'M',
  position: null,           // {x,y} of the pill, persisted
  systemPrompt: '',         // extra instructions you want prepended to every request
};

let cachedPath = null;
let cached = null;

function filePath(app) {
  if (!cachedPath) cachedPath = path.join(app.getPath('userData'), 'config.json');
  return cachedPath;
}

function load(app) {
  if (cached) return cached;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(filePath(app), 'utf8'));
  } catch (_) {
    stored = {};
  }
  cached = { ...DEFAULTS, ...stored };
  return cached;
}

function save(app, patch) {
  const current = load(app);
  cached = { ...current, ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath(app)), { recursive: true });
    fs.writeFileSync(filePath(app), JSON.stringify(cached, null, 2));
  } catch (err) {
    console.error('[pill] failed to save config:', err.message);
  }
  return cached;
}

function mask(k) {
  return k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '';
}

function isLocal(url) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(url || ''));
}

// Does the currently selected provider have what it needs to answer a question?
function chatReady(cfg) {
  if (cfg.provider === 'anthropic') return Boolean(cfg.anthropicApiKey);
  if (cfg.provider === 'gemini') return Boolean(cfg.geminiApiKey);
  return Boolean(cfg.apiKey) || isLocal(cfg.baseUrl);
}

// What the renderer is allowed to see. Keys are masked; the renderer only ever
// sends a *new* key, never reads a stored one back.
function publicView(cfg) {
  const out = { ...cfg };
  out.hasKey = Boolean(cfg.apiKey);
  out.hasAnthropicKey = Boolean(cfg.anthropicApiKey);
  out.hasDeepgramKey = Boolean(cfg.deepgramApiKey);
  out.hasDeepseekKey = Boolean(cfg.deepseekApiKey);
  out.hasGeminiKey = Boolean(cfg.geminiApiKey);
  out.chatReady = chatReady(cfg);
  out.apiKey = mask(cfg.apiKey);
  out.anthropicApiKey = mask(cfg.anthropicApiKey);
  out.deepgramApiKey = mask(cfg.deepgramApiKey);
  out.deepseekApiKey = mask(cfg.deepseekApiKey);
  out.geminiApiKey = mask(cfg.geminiApiKey);
  return out;
}

const DEFAULT_SHORTCUTS = {
  toggle: 'Control+Alt+Space',
  expand: 'Control+Alt+Return',
  ask: 'Control+Alt+A',
  solve: 'Control+Alt+S',
  record: 'Control+Alt+R',
  invisible: 'Control+Alt+I',
  up: 'Control+Alt+Up',
  down: 'Control+Alt+Down',
  left: 'Control+Alt+Left',
  right: 'Control+Alt+Right',
  quit: 'Control+Alt+X',
};

module.exports = {
  DEFAULT_SHORTCUTS, DEFAULTS, load, save, publicView, chatReady, isLocal };
