'use strict';
const { contextBridge, ipcRenderer } = require('electron');

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
  sendAudioChunk: (who, buffer, mime) => ipcRenderer.invoke('stt:chunk', { who, buffer, mime }),
  sendPcm: (who, buffer) => ipcRenderer.send('rec:pcm', { who, buffer }),
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
  runRefine: (sessionId) => ipcRenderer.invoke('refine:run', sessionId),
  sidecarStatus: () => ipcRenderer.invoke('sidecar:status'),
  setShortcuts: (patch) => ipcRenderer.invoke('shortcuts:set', patch),

  // permissions
  permissionStatus: () => ipcRenderer.invoke('perm:status'),
  requestPermissions: () => ipcRenderer.invoke('perm:request'),

  // events from main
  onMode: (fn) => on('ui:mode', fn),
  onStatus: (fn) => on('ui:status', fn),
  onCommand: (fn) => on('ui:command', fn),
  onChatStart: (fn) => on('chat:start', fn),
  onChatDelta: (fn) => on('chat:delta', fn),
  onChatNotice: (fn) => on('chat:notice', fn),
  onChatDone: (fn) => on('chat:done', fn),
  onTranscript: (fn) => on('transcript:add', fn),
  onTranscriptReset: (fn) => on('transcript:reset', fn),
  onNotesStart: (fn) => on('notes:start', fn),
  onNotesDelta: (fn) => on('notes:delta', fn),
  onNotesDone: (fn) => on('notes:done', fn),
  onRefineProgress: (fn) => on('refine:progress', fn),
  onRefineDone: (fn) => on('refine:done', fn),
});
