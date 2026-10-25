'use strict';
// Microsoft -> Xbox Live -> Minecraft authentication through the maintained
// `prismarine-auth` library, using Microsoft's OAuth device-code flow: the user
// signs in on microsoft.com in their own browser. The launcher never sees a
// password. Tokens are cached only encrypted (Electron safeStorage / Windows
// DPAPI); if encryption is unavailable they stay in memory for this run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

const CACHE_USER = 'obscura-main-account';

/** Only Microsoft sign-in pages may be opened from the device-code step. */
function isAllowedLoginUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'microsoft.com' || u.hostname.endsWith('.microsoft.com') ||
      u.hostname === 'live.com' || u.hostname.endsWith('.live.com'));
  } catch { return false; }
}

/** prismarine-auth cache factory that encrypts every file with safeStorage. */
function createEncryptedCacheFactory(dir, safeStorage) {
  const memory = new Map();
  return ({ username, cacheName }) => {
    const key = `${username}:${cacheName}`;
    const file = path.join(dir, `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.bin`);
    const canPersist = () => Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    const read = async () => {
      if (memory.has(key)) return memory.get(key);
      if (!canPersist()) return {};
      try {
        const value = JSON.parse(safeStorage.decryptString(await fs.promises.readFile(file)));
        memory.set(key, value);
        return value;
      } catch { return {}; }
    };
    const write = async (value) => {
      memory.set(key, value);
      if (!canPersist()) return;
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, safeStorage.encryptString(JSON.stringify(value)));
      await fs.promises.rename(tmp, file);
    };
    return {
      getCached: read,
      setCached: write,
      setCachedPartial: async (partial) => write({ ...(await read()), ...partial })
    };
  };
}

class AuthService {
  /**
   * @param {{ dir: string, safeStorage: any, logger: any, openExternal?: (url:string)=>any,
   *           clientId?: string|null, loadLib?: () => any }} opts
   */
  constructor({ dir, safeStorage, logger, openExternal = () => {}, clientId = null, loadLib = () => require('prismarine-auth') }) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.logger = logger;
    this.openExternal = openExternal;
    this.clientId = clientId;
    this.loadLib = loadLib;
    this.profileFile = path.join(dir, 'profile.json'); // name + uuid only, no secrets
    this.cacheFactory = createEncryptedCacheFactory(dir, safeStorage);
    this.profile = null;
    this.loginAttempt = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.profileFile, 'utf8'));
      if (typeof saved.name === 'string' && typeof saved.uuid === 'string') this.profile = { name: saved.name, uuid: saved.uuid };
    } catch { /* not signed in */ }
  }

  _flow(codeCallback) {
    const { Authflow, Titles } = this.loadLib();
    const options = this.clientId
      ? { flow: 'msal', authTitle: this.clientId } // your own Azure app registration
      : { flow: 'live', authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo' };
    return new Authflow(CACHE_USER, this.cacheFactory, options, codeCallback);
  }

  status() {
    return { loggedIn: Boolean(this.profile), profile: this.profile, secureStorage: Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable()) };
  }

  /**
   * Interactive sign-in. `onCode({userCode, url, expiresIn})` is called once so the UI can show the code.
   * Resolves with the public profile only.
   */
  async login(onCode) {
    if (this.loginAttempt) throw new AuthError('BUSY', 'Вход уже выполняется.');
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new AuthError('CANCELLED', 'Вход отменён.')); });
    this.loginAttempt = { cancel };
    try {
      const flow = this._flow((res) => {
        const url = res && (res.verification_uri || res.verificationUri);
        const userCode = res && (res.user_code || res.userCode);
        if (!url || !userCode || !isAllowedLoginUrl(url)) {
          cancel();
          return;
        }
        onCode({ userCode, url, expiresIn: Number(res.expires_in) || 900 });
        try { this.openExternal(url); } catch { /* user can open it manually */ }
      });
      const result = await Promise.race([flow.getMinecraftJavaToken({ fetchProfile: true }), cancelled]);
      return this._acceptResult(result);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      this.logger.error(err);
      throw new AuthError('LOGIN_FAILED', 'Не удалось войти в аккаунт Microsoft. Попробуйте ещё раз.');
    } finally {
      this.loginAttempt = null;
    }
  }

  cancelLogin() {
    if (!this.loginAttempt) return false;
    this.loginAttempt.cancel();
    return true;
  }

  _acceptResult(result) {
    const profile = result && result.profile;
    if (!result || typeof result.token !== 'string' || !profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') {
      throw new AuthError('NO_LICENSE', 'На этом аккаунте нет лицензии Minecraft: Java Edition.');
    }
    this.logger.redactor.addSecret(result.token);
    this.profile = { name: profile.name, uuid: profile.id };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.profileFile, JSON.stringify(this.profile));
    } catch { /* non-fatal */ }
    return { ...this.profile };
  }

  /** Non-interactive: refreshes tokens from the cache. Returns data meant for the launch command only. */
  async getSession() {
    if (!this.profile) throw new AuthError('LOGIN_REQUIRED', 'Войдите в аккаунт Microsoft (кнопка профиля слева).');
    try {
      const flow = this._flow(() => { throw new AuthError('LOGIN_REQUIRED', 'Нужно войти заново.'); });
      const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
      const p = this._acceptResult(result);
      return { accessToken: result.token, uuid: p.uuid, name: p.name };
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === 'LOGIN_REQUIRED') this.profile = null;
        throw err;
      }
      this.logger.error(err);
      throw new AuthError('LOGIN_REQUIRED', 'Сессия истекла или недоступна. Войдите в аккаунт заново.');
    }
  }

  async logout() {
    this.profile = null;
    this.cacheFactory = createEncryptedCacheFactory(this.dir, this.safeStorage);
    try {
      for (const name of await fs.promises.readdir(this.dir)) {
        if (name === 'profile.json' || name.endsWith('.bin')) await fs.promises.rm(path.join(this.dir, name), { force: true });
      }
    } catch { /* nothing stored */ }
    this.logger.redactor.clearSecrets();
  }
}

module.exports = { AuthService, AuthError, createEncryptedCacheFactory, isAllowedLoginUrl };
