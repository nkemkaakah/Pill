'use strict';
const {
  app, BrowserWindow, ipcMain, globalShortcut, screen, session,
  desktopCapturer, systemPreferences, nativeImage, Menu, shell,
} = require('electron');
const path = require('path');
const config = require('./lib/config');
const provider = require('./lib/provider');
const prompts = require('./lib/prompts');

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
const transcript = [];         // {t, who, text}
let currentRequest = null;     // { id, controller }
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
    if (!app.isPackaged && process.env.PILL_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
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

// ---------- smooth resize ----------
// BrowserWindow.setBounds's native `animate: true` on macOS drives NSWindow's
// setFrame:display:animate:, which visibly tears/flickers on transparent,
// shadowless, frameless windows like this one (Electron/Chromium don't repaint
// the GPU layer cleanly mid-animation). Stepping the bounds ourselves at 60fps
// with animate:false avoids that entirely and gives full control over easing.
let boundsAnim = null;

function stopBoundsAnim() {
  if (boundsAnim) {
    clearInterval(boundsAnim);
    boundsAnim = null;
  }
}

function animateBounds(target, duration = 220) {
  if (!win) return;
  stopBoundsAnim();
  const start = win.getBounds();
  const startTime = Date.now();
  const easeOutCubic = (t) => 1 - (1 - t) ** 3;

  send('ui:resizing', true);

  const step = () => {
    if (!win || win.isDestroyed()) { stopBoundsAnim(); return; }
    const t = Math.min(1, (Date.now() - startTime) / duration);
    const e = easeOutCubic(t);
    win.setBounds({
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e),
    }, false);
    if (t >= 1) {
      stopBoundsAnim();
      send('ui:resizing', false);
    }
  };

  boundsAnim = setInterval(step, 1000 / 60);
  step();
}

function setMode(next, sizeKey) {
  if (!win) return;
  const b = win.getBounds();
  if (next === 'panel') {
    const size = panelBounds(sizeKey || cfg.panelSize);
    mode = 'panel';
    win.setResizable(true);
    win.setMinimumSize(PANEL_MIN.width, PANEL_MIN.height);
    animateBounds(clampToWorkArea({ x: b.x, y: b.y, width: size.width, height: size.height }));
    if (sizeKey) cfg = config.save(app, { panelSize: sizeKey });
  } else {
    mode = 'pill';
    win.setResizable(false);
    win.setMinimumSize(PILL.width, PILL.height);
    animateBounds(clampToWorkArea({ x: b.x, y: b.y, width: PILL.width, height: PILL.height }));
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
  const wantsTranscript = quick ? quick.wantsTranscript : true;

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

  const transcriptText = wantsTranscript ? prompts.formatTranscript(transcript, cfg.transcriptWindowMinutes) : '';

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
  if (transcript.length > 600) transcript.splice(0, transcript.length - 600);
  send('transcript:add', entry);
  return { text: clean };
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
  ipcMain.handle('stt:clear', () => { transcript.length = 0; });
  ipcMain.handle('stt:get', () => transcript.slice(-200));

  ipcMain.handle('perm:status', () => permissionStatus());
  ipcMain.handle('perm:request', () => requestPermissions());
}

// =====================================================================
// Shortcuts
// =====================================================================
// Control+Option (⌃⌥) combos are almost never bound by macOS apps, so Pill does not
// steal Save As / Send / Log Out from whatever you are working in. Edit freely.
function registerShortcuts() {
  const map = {
    'Control+Alt+Space': ['toggle', () => toggleVisible()],
    'Control+Alt+Return': ['expand', () => { if (!win) return; if (!win.isVisible()) win.showInactive(); setMode(mode === 'pill' ? 'panel' : 'pill'); }],
    'Control+Alt+A': ['ask', () => { if (!win) return; if (!win.isVisible()) win.showInactive(); if (mode !== 'panel') setMode('panel'); win.focus(); send('ui:command', { cmd: 'focus-input', withScreenshot: true }); }],
    'Control+Alt+S': ['solve', () => { if (!win) return; if (!win.isVisible()) win.showInactive(); if (mode !== 'panel') setMode('panel'); ask({ action: 'solve' }); }],
    'Control+Alt+L': ['listen', () => send('ui:command', { cmd: 'toggle-listen' })],
    'Control+Alt+I': ['invisible', () => { cfg = config.save(app, { invisible: !cfg.invisible }); if (win) win.setContentProtection(cfg.invisible); pushStatus(); }],
    'Control+Alt+Up': ['up', () => nudge(0, -40)],
    'Control+Alt+Down': ['down', () => nudge(0, 40)],
    'Control+Alt+Left': ['left', () => nudge(-40, 0)],
    'Control+Alt+Right': ['right', () => nudge(40, 0)],
    'Control+Alt+X': ['quit', () => app.quit()],
  };
  for (const [accel, [name, fn]] of Object.entries(map)) {
    shortcutState[name] = { accel, ok: globalShortcut.register(accel, fn) };
    if (!shortcutState[name].ok) console.warn(`[pill] shortcut ${accel} is taken by another app`);
  }
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

  registerIpc();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
