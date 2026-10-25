'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { registerIpc } = require('../src/main/ipc');
const { SettingsStore } = require('../src/main/settings');
const { BackgroundStore } = require('../src/main/backgrounds');
const { Logger } = require('../src/main/logger');
const { tmp } = require('./helpers');

const TRUSTED = pathToFileURL(path.join(tmp(), 'renderer', 'index.html')).href;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

async function setup() {
  const dir = tmp();
  const handlers = new Map();
  const settings = new SettingsStore(dir);
  await settings.load();
  const logger = new Logger({ dir: null });
  const game = { async play(i) { return { echoed: i }; }, cancel: () => false, state: () => ({ busy: false }) };
  const channels = registerIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    trustedUrl: TRUSTED,
    logger,
    services: {
      settings, backgrounds: new BackgroundStore(path.join(dir, 'bg')),
      versions: { getManifest: async () => { throw new Error('secret stack /home/user/x'); } },
      auth: { status: () => ({ loggedIn: false }) }, game, system: {}, emitAuthCode: () => {}
    }
  });
  const good = { senderFrame: { url: TRUSTED, parent: null } };
  const call = (ch, ev, ...args) => handlers.get(ch)(ev, ...args);
  return { channels, call, good, handlers };
}

test('only the documented channels are registered', async () => {
  const { channels } = await setup();
  assert.deepEqual(channels.sort(), [
    'auth:cancel', 'auth:login', 'auth:logout', 'auth:status',
    'background:get', 'background:select', 'background:setCustom',
    'game:cancel', 'game:play', 'game:state',
    'settings:get', 'settings:update', 'system:info', 'versions:list'
  ]);
});

test('calls from other pages, subframes or missing frames are rejected', async () => {
  const { call, handlers } = await setup();
  for (const ev of [
    { senderFrame: { url: 'https://evil.example/index.html', parent: null } },
    { senderFrame: { url: TRUSTED, parent: {} } },
    { senderFrame: { url: 'file:///other/index.html', parent: null } },
    {}, null
  ]) {
    for (const ch of handlers.keys()) {
      const res = await call(ch, ev);
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'FORBIDDEN');
    }
  }
});

test('settings:update validates and persists; bad input returns a coded error', async () => {
  const { call, good } = await setup();
  assert.deepEqual((await call('settings:update', good, { ramGb: 8 })).data.ramGb, 8);
  assert.equal((await call('settings:get', good)).data.ramGb, 8);
  for (const bad of [{ ramGb: 999 }, { ramGb: '8' }, { version: '../x' }, { javaPath: 'rm -rf' }, { hack: 1 }, null, 'x']) {
    const res = await call('settings:update', good, bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.error.code, 'VALIDATION');
  }
  assert.equal((await call('settings:get', good)).data.ramGb, 8);
});

test('unexpected errors never leak messages or stacks to the renderer', async () => {
  const { call, good } = await setup();
  const res = await call('versions:list', good);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INTERNAL');
  assert.ok(!/secret|home/.test(res.error.message));
});

test('background:setCustom only accepts real images and persists the choice', async () => {
  const { call, good } = await setup();
  assert.equal((await call('background:setCustom', good, 'string')).ok, false);
  assert.equal((await call('background:setCustom', good, new Uint8Array(Buffer.from('<svg onload=alert(1)>'.repeat(5))))).ok, false);
  const ok = await call('background:setCustom', good, new Uint8Array(PNG));
  assert.equal(ok.ok, true);
  assert.match(ok.data.dataUrl, /^data:image\/png;base64,/);
  const state = await call('background:get', good);
  assert.equal(state.data.id, 'custom');
  assert.equal((await call('background:select', good, 'nope')).ok, false);
  assert.equal((await call('background:select', good, 'builtin-2')).ok, true);
});

test('game:play forwards only the whitelisted fields', async () => {
  const { call, good } = await setup();
  const res = await call('game:play', good, { version: 'release', repair: true, javaPath: 'C:/evil.exe', args: ['-x'] });
  assert.deepEqual(res.data.echoed, { version: 'release', repair: true });
  assert.equal((await call('game:play', good, 'x')).ok, false);
});
