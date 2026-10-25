'use strict';
// The only door between the renderer and the system. Every channel is listed
// here, accepts plain validated data, checks that the call really comes from
// the launcher's own page, and returns { ok, data } / { ok:false, error }.
// Errors are reduced to a code + redacted message; stacks never reach the UI.
const { BACKGROUND_IDS } = require('./settings');
const { MAX_BYTES } = require('./backgrounds');

function toPublicError(err, logger) {
  const byName = { ValidationError: 'VALIDATION', BackgroundError: 'BACKGROUND' };
  const known = err && ['ValidationError', 'BackgroundError', 'GameError', 'AuthError', 'VersionError'].includes(err.name);
  const code = err && typeof err.code === 'string' && /^[A-Z_]{3,32}$/.test(err.code)
    ? err.code
    : (known && byName[err.name]) || 'INTERNAL';
  if (!known) logger.error(err);
  const message = known ? logger.safe(err.message) : 'Внутренняя ошибка лаунчера. Подробности — в логе.';
  return { code, message };
}

/**
 * @param {{ ipcMain: {handle:Function}, trustedUrl: string, logger: any, services: any, emit: (channel:string,payload:any)=>void }} opts
 * @returns {string[]} registered channel names
 */
function registerIpc({ ipcMain, trustedUrl, logger, services }) {
  const { settings, backgrounds, versions, auth, game, system, emitAuthCode } = services;
  const channels = [];

  const isTrusted = (event) => {
    const frame = event && event.senderFrame;
    if (!frame || typeof frame.url !== 'string') return false;
    try {
      const a = new URL(frame.url);
      const b = new URL(trustedUrl);
      const norm = (u) => (process.platform === 'win32' ? decodeURIComponent(u.pathname).toLowerCase() : decodeURIComponent(u.pathname));
      return a.protocol === 'file:' && norm(a) === norm(b) && frame.parent === null;
    } catch { return false; }
  };

  const handle = (channel, fn) => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrusted(event)) {
        logger.warn(`Rejected IPC call on ${channel} from untrusted frame`);
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Запрос отклонён.' } };
      }
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: toPublicError(err, logger) };
      }
    });
  };

  handle('settings:get', async () => settings.get());
  handle('settings:update', async (patch) => settings.update(patch));

  handle('system:info', async () => system.info());

  handle('versions:list', async () => {
    const { manifest, source } = await versions.getManifest();
    return { source, latest: manifest.latest, versions: versions.list(manifest) };
  });

  handle('background:get', async () => {
    const id = settings.get().background;
    if (id === 'custom') {
      const dataUrl = await backgrounds.loadCustomDataUrl();
      if (dataUrl) return { id, dataUrl };
      await settings.update({ background: 'builtin-1' }); // file vanished: fall back
      return { id: 'builtin-1', dataUrl: null };
    }
    return { id, dataUrl: null };
  });
  handle('background:select', async (id) => {
    if (typeof id !== 'string' || !BACKGROUND_IDS.includes(id)) throw Object.assign(new Error('Неизвестный фон.'), { name: 'ValidationError', code: 'VALIDATION' });
    if (id === 'custom' && !(await backgrounds.hasCustom())) throw Object.assign(new Error('Свой фон ещё не выбран.'), { name: 'ValidationError', code: 'VALIDATION' });
    await settings.update({ background: id });
    return { id };
  });
  handle('background:setCustom', async (bytes) => {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
      throw Object.assign(new Error('Не удалось прочитать изображение.'), { name: 'ValidationError', code: 'VALIDATION' });
    }
    const size = bytes.byteLength;
    if (size > MAX_BYTES) throw Object.assign(new Error('Файл слишком большой.'), { name: 'ValidationError', code: 'VALIDATION' });
    await backgrounds.saveCustom(bytes);
    await settings.update({ background: 'custom' });
    return { id: 'custom', dataUrl: await backgrounds.loadCustomDataUrl() };
  });

  handle('auth:status', async () => auth.status());
  handle('auth:login', async () => auth.login((code) => emitAuthCode(code)));
  handle('auth:cancel', async () => ({ cancelled: auth.cancelLogin() }));
  handle('auth:logout', async () => { await auth.logout(); return auth.status(); });

  handle('game:play', async (input) => {
    if (!input || typeof input !== 'object') throw Object.assign(new Error('Некорректный запрос.'), { name: 'ValidationError', code: 'VALIDATION' });
    return game.play({ version: input.version, repair: input.repair === true });
  });
  handle('game:cancel', async () => ({ cancelled: game.cancel() }));
  handle('game:state', async () => game.state());

  return channels;
}

module.exports = { registerIpc, toPublicError };
