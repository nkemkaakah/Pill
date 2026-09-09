'use strict';
const {
  app, BrowserWindow, ipcMain, globalShortcut, screen, session,
  desktopCapturer, systemPreferences, nativeImage, Menu, shell,
} = require('electron');
const path = require('path');
const config = require('./lib/config');
const provider = require('./lib/provider');
const prompts = require('./lib/prompts');
const sessions = require('./lib/sessions');
const speakers = require('./lib/speakers');
const sidecarLib = require('./lib/sidecar');
const { refine } = require('./lib/refine');
const { WavWriter } = require('./lib/wav');

const isMac = process.platform === 'darwin';

// macOS system-audio loopback (what the other side of a call is saying) is exposed to
// the renderer through getDisplayMedia. Electron 31-38 needs these Chromium features
// switched on or the request rejects with "Error starting capture". Must run before ready.
if (isMac) {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}

// ---------- geometry ----------
const PILL = { width: 300, height: 46 };
const PANEL_SIZES = {
  S: { width: 440, height: 420 },
  M: { width: 540, height: 620 },
  L: { width: 720, height: 820 },
};
const PANEL_MIN = { width: 360, height: 300 };

let win = null;
let mode = 'pill'; // 'pill' | 'panel'
let cfg = null;

// ---------- state ----------
const history = [];            // chat messages (user/assistant), no system
let transcript = [];           // {t, who, text} for the current session
let activeSession = null;      // { id, startedAt, title } — current session (recording or loaded)
let recording = false;         // renderer tells us when audio capture is actually running
let currentRequest = null;     // { id, controller }
let notesRequest = null;
let wavWriters = { me: null, them: null };   // raw-audio capture for the local engine
let refining = null;                          // { sessionId, stage } while the local engine runs
const shortcutState = {};

// =====================================================================
// Window
// =====================================================================
function workAreaFor(bounds) {
  const display = screen.getDisplayMatching(bounds);
  return display.workArea;
}

function clampToWorkArea(b) {
  const wa = workAreaFor(b);
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height);
  return { ...b, x: Math.round(x), y: Math.round(y) };
}

function defaultPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + Math.round((wa.width - PILL.width) / 2), y: wa.y + 12 };
}

function panelBounds(sizeKey) {
  if (sizeKey === 'custom' && cfg.customPanel) return cfg.customPanel;
  return PANEL_SIZES[sizeKey] || PANEL_SIZES.M;
}

function createWindow() {
  cfg = config.load(app);
  const pos = cfg.position || defaultPosition();

  win = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: PILL.width,
    height: PILL.height,
    minWidth: PILL.width,
    minHeight: PILL.height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hiddenInMissionControl: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // keep transcribing while hidden
      spellcheck: false,
    },
  });

  // --- the invisibility layer ---
  // macOS: NSWindow.sharingType = .none. Windows: WDA_EXCLUDEFROMCAPTURE.
  win.setContentProtection(Boolean(cfg.invisible));
  // Float above fullscreen apps and follow the user across Spaces.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    pushStatus();
  });

  let moveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      config.save(app, { position: { x: b.x, y: b.y } });
    }, 250);
  });

  let resizeTimer = null;
  win.on('resize', () => {
    if (mode !== 'panel') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      const preset = Object.entries(PANEL_SIZES).find(([, s]) => s.width === b.width && s.height === b.height);
      if (preset) {
        cfg = config.save(app, { panelSize: preset[0] });
      } else {
        cfg = config.save(app, { panelSize: 'custom', customPanel: { width: b.width, height: b.height } });
      }
      send('ui:mode', { mode, size: cfg.panelSize });
    }, 200);
  });

  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setMode(next, sizeKey) {
  if (!win) return;
  const b = win.getBounds();
  if (next === 'panel') {
    const size = panelBounds(sizeKey || cfg.panelSize);
    mode = 'panel';
    win.setResizable(true);
    win.setMinimumSize(PANEL_MIN.width, PANEL_MIN.height);
    win.setBounds(clampToWorkArea({ x: b.x, y: b.y, width: size.width, height: size.height }), true);
    if (sizeKey) cfg = config.save(app, { panelSize: sizeKey });
  } else {
    mode = 'pill';
    win.setResizable(false);
    win.setMinimumSize(PILL.width, PILL.height);
    win.setBounds(clampToWorkArea({ x: b.x, y: b.y, width: PILL.width, height: PILL.height }), true);
  }
  send('ui:mode', { mode, size: cfg.panelSize });
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

function nudge(dx, dy) {
  if (!win) return;
  const b = win.getBounds();
  win.setBounds(clampToWorkArea({ ...b, x: b.x + dx, y: b.y + dy }));
}

function pushStatus() {
  send('ui:status', {
    invisible: Boolean(cfg.invisible),
    shortcuts: shortcutState,
    platform: process.platform,
    recording,
    refining,
    session: activeSession
      ? {
        id: activeSession.id,
        startedAt: activeSession.startedAt,
        title: activeSession.title,
        lines: transcript.length,
        refined: Boolean(activeSession.refined),
        speakers: activeSession.speakers || [],
      }
      : null,
  });
}

// =====================================================================
// Screenshot
// =====================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureScreen() {
  if (!win) return null;
  const wasVisible = win.isVisible();
  const wasFocused = win.isFocused();

  // On macOS 15+ ScreenCaptureKit ignores the content-protection flag, so the only
  // reliable way to keep the pill out of its own screenshot is to hide it for a beat.
  if (wasVisible) {
    win.hide();
    await sleep(140);
  }

  try {
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    if (!sources.length) return null;
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    let img = source.thumbnail;
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    if (width > cfg.screenshotMaxWidth) {
      img = img.resize({ width: cfg.screenshotMaxWidth, quality: 'good' });
    }
    return `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}`;
  } finally {
    if (wasVisible && win && !win.isDestroyed()) {
      win.showInactive();
      if (wasFocused) win.focus();
    }
  }
}

// =====================================================================
// Chat
// =====================================================================
let requestCounter = 0;

async function ask({ question, action, withScreenshot, smart }) {
  const id = ++requestCounter;
  if (currentRequest) currentRequest.controller.abort();
  const controller = new AbortController();
  currentRequest = { id, controller };

  const quick = action ? prompts.QUICK_ACTIONS[action] : null;
  const text = quick ? quick.prompt : String(question || '').trim();
  if (!text) return { id, error: 'Nothing to ask.' };

  const wantsShot = quick ? quick.wantsScreenshot : Boolean(withScreenshot);
  const scope = quick ? quick.transcript : cfg.transcriptScope;

  send('chat:start', { id, question: quick ? quick.label : text, withScreenshot: wantsShot });

  let screenshot = null;
  if (wantsShot) {
    try {
      screenshot = await captureScreen();
      if (!screenshot) send('chat:notice', { id, text: 'Screenshot came back empty. Grant Screen Recording in System Settings, then quit and reopen Pill.' });
    } catch (err) {
      send('chat:notice', { id, text: `Screenshot failed: ${err.message}` });
    }
  }

  let transcriptText = '';
  if (scope === 'all') transcriptText = prompts.formatWholeTranscript(transcript);
  else if (scope === 'recent') transcriptText = prompts.formatTranscript(transcript, cfg.transcriptWindowMinutes);

  const userMsg = { role: 'user', content: prompts.buildUserContent({ question: text, screenshotDataUrl: screenshot, transcriptText }) };
  const priorHistory = prompts.stripImages(history.slice(-14));
  history.push(userMsg);

  const messages = [
    { role: 'system', content: prompts.buildSystem(cfg.systemPrompt) },
    ...priorHistory,
    userMsg,
  ];

  const useAnthropic = cfg.provider === 'anthropic';
  const model = useAnthropic
    ? (smart ? cfg.anthropicSmartModel : cfg.anthropicFastModel)
    : (smart ? cfg.smartModel : cfg.fastModel);
  let full = '';
  try {
    if (!config.chatReady(cfg)) {
      throw new Error(useAnthropic
        ? 'No Anthropic key set. Open settings (the gear) and paste one.'
        : 'No OpenAI key set. Open settings (the gear) and paste one, or point Base URL at a local model.');
    }
    full = await provider.chat(cfg.provider, {
      baseUrl: useAnthropic ? cfg.anthropicBaseUrl : cfg.baseUrl,
      apiKey: useAnthropic ? cfg.anthropicApiKey : cfg.apiKey,
      model,
      messages,
      reasoningEffort: cfg.reasoningEffort,
      maxTokens: cfg.maxOutputTokens,
      signal: controller.signal,
      onDelta: (delta) => send('chat:delta', { id, text: delta }),
    });
    history.push({ role: 'assistant', content: full });
    send('chat:done', { id, text: full, model });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (full) history.push({ role: 'assistant', content: full });
      send('chat:done', { id, text: full, aborted: true, model });
    } else {
      history.pop(); // drop the failed user turn so a retry is clean
      send('chat:done', { id, text: full, error: err.message, model });
    }
  } finally {
    if (currentRequest && currentRequest.id === id) currentRequest = null;
  }
  return { id };
}

// =====================================================================
// Speech to text
// =====================================================================
const HALLUCINATIONS = new Set(['you', 'thank you.', 'thanks.', 'bye.', '.', 'thank you', 'thanks for watching.', 'okay.', 'ok.']);

async function handleAudioChunk({ who, buffer, mime }) {
  if (!cfg.sttEnabled) return { text: '' };
  if (!cfg.apiKey) return { text: '', error: 'Transcription needs an OpenAI key (Anthropic has no speech-to-text). Add one in settings or turn transcription off.' };
  const previous = transcript.filter((e) => e.who === who).slice(-3).map((e) => e.text).join(' ').slice(-200);
  const text = await provider.transcribe({
    baseUrl: cfg.sttBaseUrl || cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.sttModel,
    audio: Buffer.from(buffer),
    mime,
    prompt: previous || undefined,
    language: cfg.sttLanguage,
  });
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 2 || HALLUCINATIONS.has(clean.toLowerCase())) return { text: '' };
  const entry = { t: Date.now(), who, text: clean };
  transcript.push(entry);
  if (activeSession) sessions.append(activeSession.id, entry);
  send('transcript:add', entry);
  return { text: clean };
}

// =====================================================================
// Sessions and notes
// =====================================================================
function startSession() {
  activeSession = sessions.create('');
  activeSession.speakers = [];
  transcript = [];
  recording = true;
  closeWavWriters();
  try {
    wavWriters.me = new WavWriter(sessions.audioFileFor(activeSession.id, 'me'));
    wavWriters.them = new WavWriter(sessions.audioFileFor(activeSession.id, 'them'));
  } catch (err) {
    console.error('[pill] wav writers failed:', err.message);
  }
  send('transcript:reset', { session: activeSession, entries: [] });
  pushStatus();
  return activeSession;
}

function closeWavWriters() {
  const out = {};
  for (const who of ['me', 'them']) {
    const w = wavWriters[who];
    if (!w) continue;
    try {
      out[who] = w.finish();
    } catch (err) {
      console.error(`[pill] wav finish ${who}:`, err.message);
    }
    wavWriters[who] = null;
  }
  return out;
}

function appendPcm(who, buffer) {
  const w = wavWriters[who];
  if (!w || !recording) return;
  try {
    w.append(Buffer.from(buffer));
  } catch (err) {
    console.error(`[pill] wav append ${who}:`, err.message);
  }
}

function stopRecording() {
  recording = false;
  const finished = closeWavWriters();
  pushStatus();
  if (activeSession && cfg.localRefine) refineSession(activeSession.id, finished);
}

// =====================================================================
// Local refinement (transcribe + diarize + speaker matching)
// =====================================================================
async function refineSession(sessionId) {
  const bin = sidecarLib.locate(cfg.sidecarPath);
  if (!bin) {
    send('refine:done', { sessionId, skipped: true, reason: 'Local engine not installed — kept the live transcript. See Settings → Local engine.' });
    return;
  }
  if (refining) {
    send('refine:done', { sessionId, error: 'Another refinement is already running.' });
    return;
  }
  const paths = sessions.audioPaths(sessionId);
  refining = { sessionId, stage: 'starting' };
  pushStatus();
  const t0 = Date.now();
  try {
    const result = await refine({
      bin,
      meWav: paths.me,
      themWav: paths.them,
      roster: speakers.all(),
      threshold: cfg.speakerMatchThreshold,
      onStage: (stage) => {
        refining = { sessionId, stage };
        send('refine:progress', { sessionId, stage });
        pushStatus();
      },
      onLog: (line) => send('refine:log', { sessionId, line: String(line).slice(0, 500) }),
    });
    // "Saves it over time": every re-identified voice sharpens the roster print.
    for (const sp of result.speakers) {
      if (sp.uid && sp.similarity >= (cfg.speakerMatchThreshold ?? 0.45)) speakers.reinforce(sp.uid, sp.embedding);
    }
    const saved = sessions.applyFinal(sessionId, result.utterances, result.speakers);
    if (activeSession && activeSession.id === sessionId && saved) {
      activeSession.refined = true;
      activeSession.speakers = saved.speakers;
      transcript = saved.entries;
      send('transcript:reset', { session: sessionAbstract(saved), entries: saved.entries });
    }
    send('refine:done', { sessionId, stats: result.stats, seconds: Math.round((Date.now() - t0) / 1000) });
  } catch (err) {
    console.error('[pill] refine failed:', err.message);
    send('refine:done', { sessionId, error: err.message });
  } finally {
    refining = null;
    pushStatus();
  }
}

function sessionAbstract(s) {
  return { id: s.id, startedAt: s.startedAt, title: s.title, lines: s.entries.length, refined: s.refined, speakers: s.speakers };
}

function renameSpeaker(sessionId, key, name) {
  const clean = String(name || '').trim();
  if (!clean) return { error: 'Name is empty.' };
  const sess = sessions.load(sessionId);
  if (!sess) return { error: 'Session not found.' };
  const sp = sess.speakers.find((x) => x.key === key);
  let uid = sp ? sp.uid : null;
  if (sp) {
    if (uid) {
      speakers.rename(uid, clean); // same person, corrected name — applies everywhere
    } else {
      const existing = speakers.all().find((r) => r.name.toLowerCase() === clean.toLowerCase());
      if (existing) {
        if (Array.isArray(sp.embedding) && sp.embedding.length) speakers.reinforce(existing.uid, sp.embedding);
        uid = existing.uid;
      } else if (Array.isArray(sp.embedding) && sp.embedding.length) {
        uid = speakers.enroll(clean, sp.embedding).uid;
      }
    }
  }
  const saved = sessions.renameSpeaker(sessionId, key, clean, uid);
  if (activeSession && activeSession.id === sessionId && saved) {
    activeSession.speakers = saved.speakers;
    transcript = saved.entries;
    send('transcript:reset', { session: sessionAbstract(saved), entries: saved.entries });
  }
  pushStatus();
  return { ok: true, speakers: saved ? saved.speakers : [] };
}

function loadSession(id) {
  const s = sessions.load(id);
  if (!s) return null;
  if (recording) return { error: 'Stop the current recording before opening another activeSession.' };
  activeSession = { id: s.id, startedAt: s.startedAt, title: s.title, refined: s.refined, speakers: s.speakers };
  transcript = s.entries;
  send('transcript:reset', { session: sessionAbstract(s), entries: transcript });
  pushStatus();
  return s;
}

async function generateNotes() {
  if (!activeSession || !transcript.length) return { error: 'Nothing recorded yet. Press Record, have the conversation, then generate notes.' };
  if (notesRequest) notesRequest.abort();
  const controller = new AbortController();
  notesRequest = controller;
  const useAnthropic = cfg.provider === 'anthropic';
  const model = useAnthropic ? cfg.anthropicSmartModel : cfg.smartModel;
  const messages = [
    { role: 'system', content: prompts.buildSystem(cfg.systemPrompt) },
    { role: 'user', content: `${prompts.formatWholeTranscript(transcript, 120_000)}\n\n${prompts.NOTES_PROMPT}` },
  ];
  send('notes:start', { sessionId: activeSession.id });
  let full = '';
  try {
    if (!config.chatReady(cfg)) throw new Error('No API key set for the selected provider.');
    full = await provider.chat(cfg.provider, {
      baseUrl: useAnthropic ? cfg.anthropicBaseUrl : cfg.baseUrl,
      apiKey: useAnthropic ? cfg.anthropicApiKey : cfg.apiKey,
      model,
      messages,
      reasoningEffort: 'medium',
      maxTokens: 4096,
      signal: controller.signal,
      onDelta: (delta) => send('notes:delta', { sessionId: activeSession.id, text: delta }),
    });
    const file = sessions.saveNotes(activeSession.id, full);
    const titleMatch = /^#\s+(.+)$/m.exec(full);
    if (titleMatch && !activeSession.title) {
      activeSession.title = titleMatch[1].trim();
      sessions.setTitle(activeSession.id, activeSession.title);
    }
    send('notes:done', { sessionId: activeSession.id, text: full, file });
    pushStatus();
    return { text: full, file };
  } catch (err) {
    send('notes:done', { sessionId: activeSession.id, text: full, error: err.name === 'AbortError' ? 'stopped' : err.message });
    return { error: err.message };
  } finally {
    if (notesRequest === controller) notesRequest = null;
  }
}

// =====================================================================
// Permissions (macOS)
// =====================================================================
async function permissionStatus() {
  if (!isMac) return { mic: 'granted', screen: 'granted' };
  return {
    mic: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen'),
  };
}

async function requestPermissions() {
  if (!isMac) return permissionStatus();
  if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    // No askForMediaAccess('screen'); enumerating sources triggers the system prompt
    // and adds the app to the Screen Recording list.
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch (_) { /* noop */ }
  }
  return permissionStatus();
}

// =====================================================================
// IPC
// =====================================================================
function registerIpc() {
  ipcMain.handle('config:get', () => ({ ...config.publicView(cfg), mode, panelSizes: PANEL_SIZES }));

  ipcMain.handle('config:set', (_e, patch) => {
    const clean = { ...patch };
    // The renderer shows masked keys; only accept real new ones.
    for (const field of ['apiKey', 'anthropicApiKey']) {
      if (typeof clean[field] === 'string') {
        const k = clean[field].trim();
        if (!k || k.includes('…')) delete clean[field];
        else clean[field] = k;
      }
    }
    cfg = config.save(app, clean);
    if (win && typeof clean.invisible === 'boolean') win.setContentProtection(clean.invisible);
    pushStatus();
    return config.publicView(cfg);
  });

  ipcMain.handle('window:mode', (_e, { mode: next, size }) => { setMode(next, size); return { mode }; });
  ipcMain.handle('window:hide', () => { if (win) win.hide(); });
  ipcMain.handle('window:focus', () => { if (win) win.focus(); });
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:open-external', (_e, url) => shell.openExternal(url));

  ipcMain.handle('chat:ask', (_e, payload) => ask(payload));
  ipcMain.handle('chat:abort', () => { if (currentRequest) currentRequest.controller.abort(); });
  ipcMain.handle('chat:clear', () => { history.length = 0; });

  ipcMain.handle('shot:capture', async () => ({ dataUrl: await captureScreen() }));

  ipcMain.handle('stt:chunk', async (_e, payload) => {
    try {
      return await handleAudioChunk(payload);
    } catch (err) {
      return { text: '', error: err.message };
    }
  });
  ipcMain.handle('rec:started', () => startSession());
  ipcMain.handle('rec:stopped', () => stopRecording());
  ipcMain.on('rec:pcm', (_e, { who, buffer }) => appendPcm(who === 'me' ? 'me' : 'them', buffer));
  ipcMain.handle('speaker:rename', (_e, { sessionId, key, name }) => renameSpeaker(sessionId, key, name));
  ipcMain.handle('speaker:list', () => speakers.list());
  ipcMain.handle('refine:run', (_e, id) => { refineSession(id || (activeSession && activeSession.id)); return true; });
  ipcMain.handle('sidecar:status', () => sidecarLib.status(cfg.sidecarPath));
  ipcMain.handle('shortcuts:set', (_e, patch) => setShortcuts(patch));
  ipcMain.handle('stt:get', () => ({ session: activeSession, entries: transcript, recording }));

  ipcMain.handle('session:list', () => sessions.list());
  ipcMain.handle('session:load', (_e, id) => loadSession(id));
  ipcMain.handle('session:remove', (_e, id) => {
    sessions.remove(id);
    if (activeSession && activeSession.id === id) { activeSession = null; transcript = []; send('transcript:reset', { session: null, entries: [] }); pushStatus(); }
    return sessions.list();
  });
  ipcMain.handle('session:open-folder', () => shell.openPath(sessions.folder()));
  ipcMain.handle('session:rename', (_e, { id, title }) => { sessions.setTitle(id, title); if (activeSession && activeSession.id === id) activeSession.title = title; pushStatus(); });
  ipcMain.handle('notes:generate', () => generateNotes());
  ipcMain.handle('notes:abort', () => { if (notesRequest) notesRequest.abort(); });

  ipcMain.handle('perm:status', () => permissionStatus());
  ipcMain.handle('perm:request', () => requestPermissions());
}

// =====================================================================
// Shortcuts
// =====================================================================
// Control+Option (⌃⌥) combos are almost never bound by macOS apps, so Pill does not
// steal Save As / Send / Log Out from whatever you are working in. Edit freely.
const SHORTCUT_ACTIONS = {
  toggle: { label: 'Show / hide Pill', fn: () => toggleVisible() },
  expand: { label: 'Expand / collapse', fn: () => { if (!win) return; if (!win.isVisible()) win.showInactive(); setMode(mode === 'pill' ? 'panel' : 'pill'); } },
  ask: { label: 'Ask about my screen', fn: () => { if (!win) return; if (!win.isVisible()) win.showInactive(); if (mode !== 'panel') setMode('panel'); win.focus(); send('ui:command', { cmd: 'focus-input', withScreenshot: true }); } },
  solve: { label: 'Solve what is on screen', fn: () => { if (!win) return; if (!win.isVisible()) win.showInactive(); if (mode !== 'panel') setMode('panel'); ask({ action: 'solve' }); } },
  record: { label: 'Start / stop recording', fn: () => send('ui:command', { cmd: 'toggle-record' }) },
  invisible: { label: 'Toggle hidden from share', fn: () => { cfg = config.save(app, { invisible: !cfg.invisible }); if (win) win.setContentProtection(cfg.invisible); pushStatus(); } },
  up: { label: 'Move up', fn: () => nudge(0, -40) },
  down: { label: 'Move down', fn: () => nudge(0, 40) },
  left: { label: 'Move left', fn: () => nudge(-40, 0) },
  right: { label: 'Move right', fn: () => nudge(40, 0) },
  quit: { label: 'Quit Pill', fn: () => app.quit() },
};

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const accels = { ...config.DEFAULT_SHORTCUTS, ...(cfg.shortcuts || {}) };
  const seen = new Set();
  for (const [name, action] of Object.entries(SHORTCUT_ACTIONS)) {
    const accel = accels[name];
    if (!accel) {
      shortcutState[name] = { accel: '', ok: true, label: action.label, disabled: true };
      continue;
    }
    let ok = false;
    let why = '';
    if (seen.has(accel)) {
      why = 'duplicate';
    } else {
      seen.add(accel);
      try {
        ok = globalShortcut.register(accel, action.fn);
        if (!ok) why = 'taken by another app';
      } catch (err) {
        why = 'invalid accelerator';
      }
    }
    shortcutState[name] = { accel, ok, label: action.label, why };
    if (!ok) console.warn(`[pill] shortcut ${name} (${accel}): ${why}`);
  }
}

function setShortcuts(patch) {
  const next = { ...config.DEFAULT_SHORTCUTS, ...(cfg.shortcuts || {}) };
  for (const [name, accel] of Object.entries(patch || {})) {
    if (name in SHORTCUT_ACTIONS) next[name] = String(accel || '');
  }
  cfg = config.save(app, { shortcuts: next });
  registerShortcuts();
  pushStatus();
  return shortcutState;
}

// Dock-less apps get no menu, and without an Edit menu Cmd+C / Cmd+V do nothing in
// text fields on macOS. A minimal menu fixes that; it is never shown.
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Pill', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
}

// =====================================================================
// Lifecycle
// =====================================================================
app.whenReady().then(() => {
  if (isMac && app.dock) app.dock.hide();
  installMenu();

  // Let the renderer use mic + screen without a Chromium permission prompt.
  const media = new Set(['media', 'microphone', 'audioCapture', 'display-capture', 'screen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(media.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => media.has(permission));

  // getDisplayMedia -> primary screen with system-audio loopback. The renderer throws
  // the video track away and keeps the audio: that is the "them" channel.
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then((sources) => {
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: isMac ? 'loopback' : true });
      })
      .catch(() => callback({}));
  }, { useSystemPicker: false });

  sessions.init(app);
  speakers.init(app);
  registerIpc();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  closeWavWriters(); // patch WAV headers so a mid-meeting quit still leaves readable audio
});
app.on('window-all-closed', () => app.quit());
