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
  anthropicFastModel: 'claude-sonnet-5',
  anthropicSmartModel: 'claude-opus-5',

  // OpenAI-compatible. `apiKey` is the OpenAI key; it is also what transcription uses.
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  fastModel: 'gpt-5.6-luna',
  smartModel: 'gpt-5.6-terra',

  reasoningEffort: 'low', // none | low | medium | high  (sent only to models that accept it)
  maxOutputTokens: 4096,

  // Speech to text. Always hits OpenAI's /audio/transcriptions (Ollama has no STT).
  sttEnabled: true,
  sttModel: 'gpt-4o-mini-transcribe',
  sttBaseUrl: 'https://api.openai.com/v1',
  sttLanguage: 'en',        // ISO-639-1, or '' to auto-detect
  chunkSeconds: 6,          // how often audio is cut and sent for transcription
  silenceGate: 0.012,       // RMS below this = skip the chunk (saves money, avoids Whisper hallucinating)

  // Behaviour
  invisible: true,          // setContentProtection — hidden from screen share / recording
  attachScreenshot: true,   // every question carries a fresh screenshot by default
  screenshotMaxWidth: 1600,
  // Local engine (FluidAudio sidecar)
  localRefine: true,           // after Stop, rebuild the transcript locally with speaker labels
  sidecarPath: '',             // custom path to fluidaudiocli (blank = auto-detect)
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
  return Boolean(cfg.apiKey) || isLocal(cfg.baseUrl);
}

// What the renderer is allowed to see. Keys are masked; the renderer only ever
// sends a *new* key, never reads a stored one back.
function publicView(cfg) {
  const out = { ...cfg };
  out.hasKey = Boolean(cfg.apiKey);
  out.hasAnthropicKey = Boolean(cfg.anthropicApiKey);
  out.chatReady = chatReady(cfg);
  out.apiKey = mask(cfg.apiKey);
  out.anthropicApiKey = mask(cfg.anthropicApiKey);
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
