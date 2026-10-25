'use strict';
// Runs in an isolated world with a sandbox. It exposes a small, frozen API
// to the page; the page never receives ipcRenderer, Node.js or the raw event.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('obscura', Object.freeze({
  settings: Object.freeze({
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch)
  }),
  system: Object.freeze({ info: () => call('system:info') }),
  versions: Object.freeze({ list: () => call('versions:list') }),
  background: Object.freeze({
    get: () => call('background:get'),
    select: (id) => call('background:select', id),
    setCustom: (bytes) => call('background:setCustom', bytes)
  }),
  auth: Object.freeze({
    status: () => call('auth:status'),
    login: () => call('auth:login'),
    cancel: () => call('auth:cancel'),
    logout: () => call('auth:logout'),
    onCode: (callback) => subscribe('auth:code', callback)
  }),
  game: Object.freeze({
    play: (input) => call('game:play', input),
    cancel: () => call('game:cancel'),
    state: () => call('game:state'),
    onEvent: (callback) => subscribe('game:event', callback)
  })
}));
