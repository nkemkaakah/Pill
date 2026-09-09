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

  // speech to text
  sendAudioChunk: (who, buffer, mime) => ipcRenderer.invoke('stt:chunk', { who, buffer, mime }),
  clearTranscript: () => ipcRenderer.invoke('stt:clear'),
  getTranscript: () => ipcRenderer.invoke('stt:get'),

  // permissions
  permissionStatus: () => ipcRenderer.invoke('perm:status'),
  requestPermissions: () => ipcRenderer.invoke('perm:request'),

  // events from main
  onMode: (fn) => on('ui:mode', fn),
  onResizing: (fn) => on('ui:resizing', fn),
  onStatus: (fn) => on('ui:status', fn),
  onCommand: (fn) => on('ui:command', fn),
  onChatStart: (fn) => on('chat:start', fn),
  onChatDelta: (fn) => on('chat:delta', fn),
  onChatNotice: (fn) => on('chat:notice', fn),
  onChatDone: (fn) => on('chat:done', fn),
  onTranscript: (fn) => on('transcript:add', fn),
});
