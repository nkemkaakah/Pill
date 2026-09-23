'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const { Resampler, floatToInt16, SAMPLE_RATE } = require('./lib/wav');

// The renderer cannot require() Node modules, so it used to carry its own copy of the
// resampler — two implementations of the same maths, only one of them unit-tested.
// Preload runs in the Node context, so the real one lives here instead and the renderer
// just hands over raw float samples. Resampling happens in-process; only the finished
// 16 kHz Int16 crosses the IPC boundary, so this costs nothing on the wire.
const pcm = {};

function pushPcm(who, floatBuffer, fromRate) {
  let st = pcm[who];
  if (!st || st.fromRate !== fromRate) {
    st = { fromRate, resampler: new Resampler(fromRate, SAMPLE_RATE), pending: [], pendingLen: 0 };
    pcm[who] = st;
  }
  const i16 = floatToInt16(st.resampler.process(new Float32Array(floatBuffer)));
  if (!i16.length) return;
  st.pending.push(i16);
  st.pendingLen += i16.length;
  if (st.pendingLen < SAMPLE_RATE / 2) return; // flush ~every 0.5s

  const merged = new Int16Array(st.pendingLen);
  let off = 0;
  for (const part of st.pending) { merged.set(part, off); off += part.length; }
  st.pending = [];
  st.pendingLen = 0;
  ipcRenderer.send('rec:pcm', { who, buffer: merged.buffer });
}

const on = (channel, fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('pill', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // window
  setMode: (mode, size) => ipcRenderer.invoke('window:mode', { mode, size }),
  hide: () => ipcRenderer.invoke('window:hide'),
  focus: () => ipcRenderer.invoke('window:focus'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // chat
  ask: (payload) => ipcRenderer.invoke('chat:ask', payload),
  abort: () => ipcRenderer.invoke('chat:abort'),
  clearChat: () => ipcRenderer.invoke('chat:clear'),
  captureScreenshot: () => ipcRenderer.invoke('shot:capture'),

  // recording / speech to text
  // Raw float samples at the AudioContext's own rate; preload resamples and batches.
  sendPcmFloat: (who, floatBuffer, fromRate) => pushPcm(who, floatBuffer, fromRate),
  resetPcm: (who) => { delete pcm[who]; },
  recordingStarted: () => ipcRenderer.invoke('rec:started'),
  recordingStopped: () => ipcRenderer.invoke('rec:stopped'),
  getTranscript: () => ipcRenderer.invoke('stt:get'),

  // sessions + notes
  listSessions: () => ipcRenderer.invoke('session:list'),
  loadSession: (id) => ipcRenderer.invoke('session:load', id),
  removeSession: (id) => ipcRenderer.invoke('session:remove', id),
  renameSession: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),
  openSessionsFolder: () => ipcRenderer.invoke('session:open-folder'),
  generateNotes: () => ipcRenderer.invoke('notes:generate'),
  abortNotes: () => ipcRenderer.invoke('notes:abort'),

  // local engine + speakers + shortcuts
  renameSpeaker: (sessionId, key, name) => ipcRenderer.invoke('speaker:rename', { sessionId, key, name }),
  listSpeakers: () => ipcRenderer.invoke('speaker:list'),
  // Accepts a bare session id, or { id, cloud } to pick the engine.
  runRefine: (arg) => ipcRenderer.invoke('refine:run', arg),
  sidecarStatus: () => ipcRenderer.invoke('sidecar:status'),
  setShortcuts: (patch) => ipcRenderer.invoke('shortcuts:set', patch),

  // context document
  contextStatus: () => ipcRenderer.invoke('context:status'),
  uploadContext: () => ipcRenderer.invoke('context:upload'),
  removeContext: () => ipcRenderer.invoke('context:remove'),

  // permissions
  permissionStatus: () => ipcRenderer.invoke('perm:status'),
  requestPermissions: () => ipcRenderer.invoke('perm:request'),
  resetPermissions: () => ipcRenderer.invoke('perm:reset'),
  openPermissionSettings: (pane) => ipcRenderer.invoke('perm:open-settings', pane),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),

  // events from main
  onMode: (fn) => on('ui:mode', fn),
  onStatus: (fn) => on('ui:status', fn),
  onCommand: (fn) => on('ui:command', fn),
  onChatStart: (fn) => on('chat:start', fn),
  onChatDelta: (fn) => on('chat:delta', fn),
  onChatNotice: (fn) => on('chat:notice', fn),
  onChatDone: (fn) => on('chat:done', fn),
  onTranscript: (fn) => on('transcript:add', fn),
  onTranscriptPartial: (fn) => on('transcript:partial', fn),
  onTranscriptReset: (fn) => on('transcript:reset', fn),
  onNotesStart: (fn) => on('notes:start', fn),
  onNotesDelta: (fn) => on('notes:delta', fn),
  onNotesDone: (fn) => on('notes:done', fn),
  onRefineProgress: (fn) => on('refine:progress', fn),
  onRefineDone: (fn) => on('refine:done', fn),
  onRefineLog: (fn) => on('refine:log', fn),
  onCaptureStatus: (fn) => on('capture:status', fn),
});
