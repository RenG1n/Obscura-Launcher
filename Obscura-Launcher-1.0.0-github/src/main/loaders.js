'use strict';
// Mod loaders: Fabric (official Fabric Meta + Maven) and Forge (official
// installer from Forge's Maven, run with the game's Java). Both produce a
// normal version folder under versions/<id>/ that @xmcl/core launches through
// "inheritsFrom", exactly like the official launcher does.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('./net');
const { VERSION_ID_RE } = require('./settings');

const LOADERS = Object.freeze(['vanilla', 'fabric', 'forge', 'quilt', 'neoforge']);
const MARKER = '.obscura-installed';

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FABRIC_HOSTS = ['meta.fabricmc.net', 'maven.fabricmc.net'];
const FABRIC_LIB_HOSTS = ['maven.fabricmc.net', 'repo1.maven.org', 'repo.maven.apache.org', 'libraries.minecraft.net'];
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_HOSTS = ['files.minecraftforge.net', 'maven.minecraftforge.net'];

// Quilt Meta mirrors Fabric Meta (v3, same shape as Fabric's v2 loader/profile
// endpoints) — Quilt's own tooling is a fork of Fabric's for this exact reason.
const QUILT_META = 'https://meta.quiltmc.org/v3';
const QUILT_HOSTS = ['meta.quiltmc.org', 'maven.quiltmc.org'];
const QUILT_LIB_HOSTS = ['maven.quiltmc.org', 'repo1.maven.org', 'repo.maven.apache.org', 'maven.fabricmc.net', 'libraries.minecraft.net'];
// NeoForge's installer is a fork of Forge's (same --installClient CLI). Its Maven
// (Reposilite) exposes a small JSON API for version listing, unlike Forge's XML/promos.
const NEOFORGE_VERSIONS_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const NEOFORGE_HOSTS = ['maven.neoforged.net'];

const LOADER_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;

class LoaderError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LoaderError';
    this.code = code;
  }
}

const LABEL = { fabric: 'Fabric', forge: 'Forge', quilt: 'Quilt', neoforge: 'NeoForge' };

/** "1.20.4" -> "20.4." — the prefix NeoForge's own version numbers encode the MC version with. */
function neoforgeMcPrefix(mcId) {
  const m = /^1\.(\d+(?:\.\d+)?)$/.exec(mcId);
  return m ? `${m[1].includes('.') ? m[1] : `${m[1]}.0`}.` : null;
}

function checkMc(mcId) {
  if (typeof mcId !== 'string' || !VERSION_ID_RE.test(mcId)) throw new LoaderError('VALIDATION', 'Недопустимая версия Minecraft.');
}
function checkLoader(loader) {
  if (!['fabric', 'forge', 'quilt', 'neoforge'].includes(loader)) throw new LoaderError('VALIDATION', 'Неизвестный загрузчик.');
}
function checkLoaderVersion(v) {
  if (v !== '' && v !== undefined && v !== null && !(typeof v === 'string' && LOADER_VERSION_RE.test(v))) throw new LoaderError('VALIDATION', 'Недопустимая версия загрузчика.');
}

/** Maven coordinate "group:artifact:version[:classifier][@ext]" -> repository-relative path. */
function mavenPath(name) {
  const m = /^([^:@\s]+):([^:@\s]+):([^:@\s]+)(?::([^:@\s]+))?(?:@([A-Za-z0-9]+))?$/.exec(String(name));
  if (!m) throw new LoaderError('LOADER_FAILED', `Некорректное имя библиотеки в профиле загрузчика: ${String(name).slice(0, 60)}`);
  const [, group, artifact, version, classifier, ext = 'jar'] = m;
  for (const part of [group, artifact, version, classifier || '']) if (part.includes('..') || part.includes('/') || part.includes('\\')) throw new LoaderError('LOADER_FAILED', 'Небезопасное имя библиотеки.');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function writeMarker(dir) { fs.writeFileSync(path.join(dir, MARKER), new Date().toISOString()); }

function isLoaderInstalled(gameDir, id, fsImpl = fs) {
  const dir = path.join(gameDir, 'versions', id);
  return fsImpl.existsSync(path.join(dir, `${id}.json`)) && fsImpl.existsSync(path.join(dir, MARKER));
}

function defaultRun(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.output = `${stdout || ''}\n${stderr || ''}`; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

function createLoaderService({ gameDir, logger = null, transport, sleep, run = defaultRun, tmpDir = null } = {}) {
  const netOpts = (hosts, extra = {}) => ({ hosts, transport, sleep, ...extra });

  // ------------------------------------------------------------------ Fabric
  async function fabricVersions(mcId, signal) {
    const list = await net.fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcId)}`, netOpts(FABRIC_HOSTS, { signal }));
    const out = [];
    for (const row of Array.isArray(list) ? list : []) {
      const v = row && row.loader && row.loader.version;
      if (typeof v !== 'string' || !LOADER_VERSION_RE.test(v)) continue;
      out.push({ id: v, stable: row.loader.stable === true });
    }
    return out;
  }

  async function installFabric(mcId, wanted, { signal, onProgress, repair }) {
    if (wanted && !repair && isLoaderInstalled(gameDir, `fabric-loader-${wanted}-${mcId}`)) return `fabric-loader-${wanted}-${mcId}`;
    const versions = await fabricVersions(mcId, signal);
    if (versions.length === 0) throw new LoaderError('LOADER_UNSUPPORTED', `Fabric не поддерживает Minecraft ${mcId}.`);
    const loaderVersion = wanted ? wanted : (versions.find((v) => v.stable) || versions[0]).id;
    if (wanted && !versions.some((v) => v.id === wanted)) throw new LoaderError('LOADER_UNSUPPORTED', `Fabric Loader ${wanted} недоступен для Minecraft ${mcId}.`);
    const id = `fabric-loader-${loaderVersion}-${mcId}`;
    if (!repair && isLoaderInstalled(gameDir, id)) return id;

    const profile = await net.fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcId)}/${encodeURIComponent(loaderVersion)}/profile/json`, netOpts(FABRIC_HOSTS, { signal }));
    if (!profile || typeof profile !== 'object' || profile.id !== id || profile.inheritsFrom !== mcId || !Array.isArray(profile.libraries) || typeof profile.mainClass !== 'string') {
      throw new LoaderError('LOADER_FAILED', 'Fabric вернул неожиданный профиль версии.');
    }
    const libs = [];
    for (const lib of profile.libraries) {
      if (!lib || typeof lib.name !== 'string') continue;
      const rel = mavenPath(lib.name);
      const base = typeof lib.url === 'string' ? lib.url : 'https://maven.fabricmc.net/';
      const url = new URL(rel, base.endsWith('/') ? base : `${base}/`);
      net.assertUrl(url.href, FABRIC_LIB_HOSTS);
      libs.push({ rel, url: url.href });
    }
    let done = 0;
    const emit = () => { if (onProgress) onProgress({ percent: Math.round((done / Math.max(1, libs.length)) * 100) }); };
    emit();
    const queue = [...libs];
    const worker = async () => {
      for (let lib = queue.shift(); lib; lib = queue.shift()) {
        const dest = path.join(gameDir, 'libraries', ...lib.rel.split('/'));
        let have = false;
        try { have = fs.statSync(dest).size > 0; } catch { /* missing */ }
        if (!have) {
          let sha1;
          try { sha1 = (await net.fetchText(`${lib.url}.sha1`, netOpts(FABRIC_LIB_HOSTS, { signal, maxBytes: 1024, retries: 1 }))).trim().split(/\s+/)[0]; } catch { sha1 = undefined; }
          if (sha1 && !/^[0-9a-f]{40}$/i.test(sha1)) sha1 = undefined;
          await net.downloadFile(lib.url, dest, netOpts(FABRIC_LIB_HOSTS, { signal, sha1, maxBytes: 128 * 1024 * 1024 }));
        }
        done++;
        emit();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, libs.length) }, worker));
    const dir = path.join(gameDir, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(profile, null, 2));
    writeMarker(dir);
    return id;
  }

  // -------------------------------------------------------------------- Quilt
  async function quiltVersions(mcId, signal) {
    const list = await net.fetchJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcId)}`, netOpts(QUILT_HOSTS, { signal }));
    const out = [];
    for (const row of Array.isArray(list) ? list : []) {
      const v = row && row.loader && row.loader.version;
      if (typeof v !== 'string' || !LOADER_VERSION_RE.test(v)) continue;
      out.push({ id: v, stable: !/beta|pre|rc/i.test(v) });
    }
    return out;
  }

  async function installQuilt(mcId, wanted, { signal, onProgress, repair }) {
    if (wanted && !repair && isLoaderInstalled(gameDir, `quilt-loader-${wanted}-${mcId}`)) return `quilt-loader-${wanted}-${mcId}`;
    const versions = await quiltVersions(mcId, signal);
    if (versions.length === 0) throw new LoaderError('LOADER_UNSUPPORTED', `Quilt не поддерживает Minecraft ${mcId}.`);
    const loaderVersion = wanted ? wanted : (versions.find((v) => v.stable) || versions[0]).id;
    if (wanted && !versions.some((v) => v.id === wanted)) throw new LoaderError('LOADER_UNSUPPORTED', `Quilt Loader ${wanted} недоступен для Minecraft ${mcId}.`);
    const id = `quilt-loader-${loaderVersion}-${mcId}`;
    if (!repair && isLoaderInstalled(gameDir, id)) return id;

    const profile = await net.fetchJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcId)}/${encodeURIComponent(loaderVersion)}/profile/json`, netOpts(QUILT_HOSTS, { signal }));
    if (!profile || typeof profile !== 'object' || profile.id !== id || profile.inheritsFrom !== mcId || !Array.isArray(profile.libraries) || typeof profile.mainClass !== 'string') {
      throw new LoaderError('LOADER_FAILED', 'Quilt вернул неожиданный профиль версии.');
    }
    const libs = [];
    for (const lib of profile.libraries) {
      if (!lib || typeof lib.name !== 'string') continue;
      const rel = mavenPath(lib.name);
      const base = typeof lib.url === 'string' ? lib.url : 'https://maven.quiltmc.org/repository/release/';
      const url = new URL(rel, base.endsWith('/') ? base : `${base}/`);
      net.assertUrl(url.href, QUILT_LIB_HOSTS);
      libs.push({ rel, url: url.href });
    }
    let done = 0;
    const emit = () => { if (onProgress) onProgress({ percent: Math.round((done / Math.max(1, libs.length)) * 100) }); };
    emit();
    const queue = [...libs];
    const worker = async () => {
      for (let lib = queue.shift(); lib; lib = queue.shift()) {
        const dest = path.join(gameDir, 'libraries', ...lib.rel.split('/'));
        let have = false;
        try { have = fs.statSync(dest).size > 0; } catch { /* missing */ }
        if (!have) {
          let sha1;
          try { sha1 = (await net.fetchText(`${lib.url}.sha1`, netOpts(QUILT_LIB_HOSTS, { signal, maxBytes: 1024, retries: 1 }))).trim().split(/\s+/)[0]; } catch { sha1 = undefined; }
          if (sha1 && !/^[0-9a-f]{40}$/i.test(sha1)) sha1 = undefined;
          await net.downloadFile(lib.url, dest, netOpts(QUILT_LIB_HOSTS, { signal, sha1, maxBytes: 128 * 1024 * 1024 }));
        }
        done++;
        emit();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, libs.length) }, worker));
    const dir = path.join(gameDir, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(profile, null, 2));
    writeMarker(dir);
    return id;
  }

  // ------------------------------------------------------------------- Forge
  async function forgeVersions(mcId, signal) {
    const data = await net.fetchJson(FORGE_PROMOS, netOpts(FORGE_HOSTS, { signal }));
    const promos = data && typeof data.promos === 'object' && data.promos ? data.promos : {};
    const out = [];
    const rec = promos[`${mcId}-recommended`];
    const latest = promos[`${mcId}-latest`];
    const ok = (v) => typeof v === 'string' && LOADER_VERSION_RE.test(v);
    if (ok(rec)) out.push({ id: rec, stable: true, recommended: true });
    if (ok(latest) && latest !== rec) out.push({ id: latest, stable: false, recommended: false });
    return out;
  }

  async function installForge(mcId, wanted, { signal, onProgress, javaPath, repair }) {
    if (wanted && !repair && isLoaderInstalled(gameDir, `${mcId}-forge-${wanted}`)) return `${mcId}-forge-${wanted}`;
    if (!javaPath) throw new LoaderError('LOADER_FAILED', 'Для установки Forge нужна Java.');
    const versions = await forgeVersions(mcId, signal);
    if (versions.length === 0) throw new LoaderError('LOADER_UNSUPPORTED', `Для Minecraft ${mcId} нет официальной сборки Forge.`);
    const forgeVersion = wanted ? wanted : versions[0].id;
    if (wanted && !versions.some((v) => v.id === wanted)) throw new LoaderError('LOADER_UNSUPPORTED', `Forge ${wanted} недоступен для Minecraft ${mcId} в списке рекомендованных сборок.`);
    const expectedId = `${mcId}-forge-${forgeVersion}`;
    if (!repair && isLoaderInstalled(gameDir, expectedId)) return expectedId;

    const full = `${mcId}-${forgeVersion}`;
    const jarUrl = `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`;
    let sha1;
    try { sha1 = (await net.fetchText(`${jarUrl}.sha1`, netOpts(FORGE_HOSTS, { signal, maxBytes: 1024, retries: 2 }))).trim().split(/\s+/)[0]; } catch { sha1 = undefined; }
    if (!sha1 || !/^[0-9a-f]{40}$/i.test(sha1)) throw new LoaderError('LOADER_FAILED', 'Не удалось получить контрольную сумму установщика Forge. Установка остановлена.');
    const work = tmpDir || path.join(gameDir, '.tmp-forge');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      const installer = path.join(work, `forge-${full}-installer.jar`);
      await net.downloadFile(jarUrl, installer, netOpts(FORGE_HOSTS, { signal, sha1, maxBytes: 200 * 1024 * 1024, onProgress: (p) => { if (onProgress) onProgress({ percent: p.percent === null ? null : Math.round(p.percent * 0.2) }); } }));
      // The Forge installer insists on a launcher_profiles.json next to the game files.
      fs.mkdirSync(gameDir, { recursive: true });
      const profiles = path.join(gameDir, 'launcher_profiles.json');
      if (!fs.existsSync(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, version: 3 }));
      const versionsDir = path.join(gameDir, 'versions');
      const before = new Set(fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : []);
      if (onProgress) onProgress({ percent: 25, message: 'Запускаю установщик Forge (это может занять несколько минут)…' });
      try {
        await run(javaPath, ['-jar', installer, '--installClient', gameDir], { cwd: work, signal });
      } catch (err) {
        if (signal && signal.aborted) throw new LoaderError('CANCELLED', 'Установка отменена.');
        const tail = String((err && err.output) || err.message).split(/\r?\n/).filter(Boolean).slice(-6).join(' ').slice(0, 400);
        throw new LoaderError('LOADER_FAILED', `Установщик Forge завершился с ошибкой: ${tail}`, { cause: err });
      }
      const after = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : [];
      const created = after.filter((n) => !before.has(n) && /forge/i.test(n) && fs.existsSync(path.join(versionsDir, n, `${n}.json`)));
      const id = created.includes(expectedId) ? expectedId : (after.includes(expectedId) ? expectedId : created[0]);
      if (!id || !fs.existsSync(path.join(versionsDir, id, `${id}.json`))) throw new LoaderError('LOADER_FAILED', 'Установщик Forge завершился, но версия не появилась в папке игры.');
      writeMarker(path.join(versionsDir, id));
      if (onProgress) onProgress({ percent: 100 });
      return id;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- NeoForge
  async function neoforgeVersions(mcId, signal) {
    const prefix = neoforgeMcPrefix(mcId);
    if (!prefix) return []; // NeoForge only exists for 1.20.2+ (its versioning scheme starts there)
    const data = await net.fetchJson(NEOFORGE_VERSIONS_API, netOpts(NEOFORGE_HOSTS, { signal }));
    const all = data && Array.isArray(data.versions) ? data.versions : [];
    const out = all.filter((v) => typeof v === 'string' && v.startsWith(prefix) && LOADER_VERSION_RE.test(v))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return out.map((id, i) => ({ id, stable: !/beta|pre|rc/i.test(id), recommended: i === out.length - 1 })).reverse();
  }

  async function installNeoForge(mcId, wanted, { signal, onProgress, javaPath, repair }) {
    const expectedId = (v) => `neoforge-${v}`;
    if (wanted && !repair && isLoaderInstalled(gameDir, expectedId(wanted))) return expectedId(wanted);
    if (!javaPath) throw new LoaderError('LOADER_FAILED', 'Для установки NeoForge нужна Java.');
    const versions = await neoforgeVersions(mcId, signal);
    if (versions.length === 0) throw new LoaderError('LOADER_UNSUPPORTED', `Для Minecraft ${mcId} нет сборки NeoForge.`);
    const neoVersion = wanted ? wanted : (versions.find((v) => v.recommended) || versions[0]).id;
    if (wanted && !versions.some((v) => v.id === wanted)) throw new LoaderError('LOADER_UNSUPPORTED', `NeoForge ${wanted} недоступен для Minecraft ${mcId}.`);
    const id = expectedId(neoVersion);
    if (!repair && isLoaderInstalled(gameDir, id)) return id;

    const jarUrl = `${NEOFORGE_MAVEN}/${neoVersion}/neoforge-${neoVersion}-installer.jar`;
    let sha1;
    try { sha1 = (await net.fetchText(`${jarUrl}.sha1`, netOpts(NEOFORGE_HOSTS, { signal, maxBytes: 1024, retries: 2 }))).trim().split(/\s+/)[0]; } catch { sha1 = undefined; }
    if (!sha1 || !/^[0-9a-f]{40}$/i.test(sha1)) throw new LoaderError('LOADER_FAILED', 'Не удалось получить контрольную сумму установщика NeoForge. Установка остановлена.');
    const work = tmpDir || path.join(gameDir, '.tmp-neoforge');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      const installer = path.join(work, `neoforge-${neoVersion}-installer.jar`);
      await net.downloadFile(jarUrl, installer, netOpts(NEOFORGE_HOSTS, { signal, sha1, maxBytes: 200 * 1024 * 1024, onProgress: (p) => { if (onProgress) onProgress({ percent: p.percent === null ? null : Math.round(p.percent * 0.2) }); } }));
      fs.mkdirSync(gameDir, { recursive: true });
      const profiles = path.join(gameDir, 'launcher_profiles.json');
      if (!fs.existsSync(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, version: 3 }));
      const versionsDir = path.join(gameDir, 'versions');
      const before = new Set(fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : []);
      if (onProgress) onProgress({ percent: 25, message: 'Запускаю установщик NeoForge (это может занять несколько минут)…' });
      try {
        await run(javaPath, ['-jar', installer, '--installClient', gameDir], { cwd: work, signal });
      } catch (err) {
        if (signal && signal.aborted) throw new LoaderError('CANCELLED', 'Установка отменена.');
        const tail = String((err && err.output) || err.message).split(/\r?\n/).filter(Boolean).slice(-6).join(' ').slice(0, 400);
        throw new LoaderError('LOADER_FAILED', `Установщик NeoForge завершился с ошибкой: ${tail}`, { cause: err });
      }
      const after = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : [];
      const created = after.filter((n) => !before.has(n) && /neoforge/i.test(n) && fs.existsSync(path.join(versionsDir, n, `${n}.json`)));
      const resolvedId = created.includes(id) ? id : (after.includes(id) ? id : created[0]);
      if (!resolvedId || !fs.existsSync(path.join(versionsDir, resolvedId, `${resolvedId}.json`))) throw new LoaderError('LOADER_FAILED', 'Установщик NeoForge завершился, но версия не появилась в папке игры.');
      writeMarker(path.join(versionsDir, resolvedId));
      if (onProgress) onProgress({ percent: 100 });
      return resolvedId;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  return {
    /** [{ id, stable, recommended? }], best first. Throws LoaderError / NetError. */
    async listVersions(loader, mcId, { signal } = {}) {
      checkLoader(loader); checkMc(mcId);
      if (loader === 'fabric') return fabricVersions(mcId, signal);
      if (loader === 'quilt') return quiltVersions(mcId, signal);
      if (loader === 'neoforge') return neoforgeVersions(mcId, signal);
      return forgeVersions(mcId, signal);
    },
    /** Newest already-installed loader build for a Minecraft version (for offline play), or null. */
    findInstalled(loader, mcId, loaderVersion = '') {
      try {
        checkLoader(loader); checkMc(mcId);
        const esc = mcId.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
        const re = loader === 'fabric' ? new RegExp(`^fabric-loader-(.+)-${esc}$`)
          : loader === 'quilt' ? new RegExp(`^quilt-loader-(.+)-${esc}$`)
          : loader === 'neoforge' ? /^neoforge-(.+)$/
          : new RegExp(`^${esc}-forge-(.+)$`);
        const found = fs.readdirSync(path.join(gameDir, 'versions'))
          .map((n) => ({ n, m: re.exec(n) })).filter((x) => x.m && isLoaderInstalled(gameDir, x.n) && (!loaderVersion || x.m[1] === loaderVersion))
          .sort((a, b) => a.m[1].localeCompare(b.m[1], undefined, { numeric: true }));
        return found.length ? found[found.length - 1].n : null;
      } catch { return null; }
    },
    /** Make sure the loader is installed; returns the version id to launch. */
    async ensure(loader, mcId, loaderVersion, { signal, onProgress, javaPath, repair = false } = {}) {
      checkLoader(loader); checkMc(mcId); checkLoaderVersion(loaderVersion);
      if (logger) logger.info(`Ensuring ${LABEL[loader]} for Minecraft ${mcId}${loaderVersion ? ` (${loaderVersion})` : ''}`);
      if (loader === 'fabric') return installFabric(mcId, loaderVersion || '', { signal, onProgress, repair });
      if (loader === 'quilt') return installQuilt(mcId, loaderVersion || '', { signal, onProgress, repair });
      if (loader === 'neoforge') return installNeoForge(mcId, loaderVersion || '', { signal, onProgress, javaPath, repair });
      return installForge(mcId, loaderVersion || '', { signal, onProgress, javaPath, repair });
    }
  };
}

module.exports = { createLoaderService, LoaderError, LOADERS, LOADER_VERSION_RE, mavenPath, isLoaderInstalled, MARKER };
