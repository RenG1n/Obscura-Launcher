'use strict';
// Orchestrates one "Play" press: resolve version -> install if needed ->
// check account -> pick Java -> validate RAM -> launch.
// All collaborators are injected so the flow can be tested without Electron,
// the network or Minecraft. Every failure is turned into a numbered report
// (see errors.js) that carries the context in which it happened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validatePatch } = require('./settings');

class GameError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GameError';
    this.code = code;
  }
}

const MARKER = '.obscura-installed';
const OUTPUT_LINES = 60;

/** Java major version a game version needs. Versions older than 1.17 do not declare one: Java 8. */
function readRequiredJavaMajor(gameDir, id, fsImpl = fs) {
  try {
    const json = JSON.parse(fsImpl.readFileSync(path.join(gameDir, 'versions', id, `${id}.json`), 'utf8'));
    const major = json && json.javaVersion && json.javaVersion.majorVersion;
    return Number.isInteger(major) && major > 0 ? major : 8;
  } catch {
    return 8;
  }
}

function isInstalled(gameDir, id, fsImpl = fs) {
  const dir = path.join(gameDir, 'versions', id);
  return ['.json', '.jar'].every((ext) => fsImpl.existsSync(path.join(dir, `${id}${ext}`))) &&
    fsImpl.existsSync(path.join(dir, MARKER));
}

function createGameService(deps) {
  const { settings, versions, auth, java, ram, installer, launcher, gameDir, logger, emit, reporter = null, fsImpl = fs } = deps;
  let busy = null;      // { abort: AbortController }
  let running = null;   // { pid }

  const send = (event) => { try { emit(event); } catch { /* UI may be gone */ } };
  const report = (err, ctx) => { try { return reporter ? reporter.report(err, ctx) : null; } catch { return null; } };

  async function play(input) {
    if (busy) throw new GameError('BUSY', 'Подготовка к запуску уже идёт.');
    if (running) throw new GameError('RUNNING', 'Игра уже запущена.');
    const abort = new AbortController();
    busy = { abort };
    const ctx = { phase: 'start', requestedVersion: input && typeof input.version === 'string' ? input.version : undefined };
    try {
      const { version } = validatePatch({ version: input && input.version });
      const s = settings.get();
      ctx.ramGb = s.ramGb;

      // 1. Resolve the requested version through Mojang's manifest.
      ctx.phase = 'resolving';
      send({ type: 'status', phase: 'resolving', message: 'Проверяю версию…' });
      let meta;
      try {
        const { manifest } = await versions.getManifest();
        meta = versions.resolve(manifest, version);
      } catch (err) {
        // Offline: an exact id that is already fully installed can still be launched.
        if (err && err.code === 'NETWORK' && !['release', 'snapshot'].includes(version) && isInstalled(gameDir, version, fsImpl)) {
          meta = { id: version };
        } else {
          throw new GameError(err.code || 'VERSION', err.message, { cause: err });
        }
      }
      ctx.resolvedVersion = meta.id;

      // 2. Install (first run of a version only; `repair` forces a re-check).
      if ((input && input.repair === true) || !isInstalled(gameDir, meta.id, fsImpl)) {
        ctx.phase = 'installing';
        send({ type: 'status', phase: 'installing', message: `Устанавливаю Minecraft ${meta.id}…`, progress: null });
        const attempts = Math.max(1, deps.installAttempts || 3);
        for (let attempt = 1; ; attempt++) {
          try {
            await installer.install(meta, gameDir, {
              signal: abort.signal,
              onProgress: (p) => send({ type: 'progress', phase: 'installing', ...p })
            });
            break;
          } catch (err) {
            if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
            logger.error(`Install attempt ${attempt}/${attempts} failed:\n${logger.describe(err)}`);
            if (attempt >= attempts) {
              const detail = logger.describe(err).split('\n').slice(0, 3).join(' ').slice(0, 280);
              ctx.attempts = attempts;
              throw new GameError('INSTALL_FAILED', `Не удалось установить Minecraft ${meta.id} (попыток: ${attempts}): ${detail}`, { cause: err });
            }
            send({ type: 'status', phase: 'installing', message: `Сбой сети, повтор ${attempt + 1} из ${attempts}…`, progress: null });
            await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? 2500));
            if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
          }
        }
        if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
        if (!fsImpl.existsSync(path.join(gameDir, 'versions', meta.id, `${meta.id}.jar`))) {
          throw new GameError('INSTALL_FAILED', 'Установка завершилась, но файлы игры не найдены.');
        }
        await fsImpl.promises.writeFile(path.join(gameDir, 'versions', meta.id, MARKER), new Date().toISOString());
      }

      // 3. Account. Local profiles are for offline/local play only; they do not authenticate
      // with Microsoft or grant access to authenticated online servers.
      ctx.phase = 'auth';
      let session;
      if (s.authMode === 'local') {
        const name = s.localUsername;
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name || '')) throw new GameError('INVALID_LOCAL_NAME', 'Ник локального профиля должен содержать 3–16 латинских букв, цифр или _.');
        const hex = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest('hex').split('');
        hex[12] = '3'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
        const raw = hex.join('');
        session = { name, uuid: `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`, accessToken: '0', userType: 'offline' };
        send({ type: 'status', phase: 'auth', message: `Локальный профиль: ${name} (офлайн-режим)…` });
      } else {
        send({ type: 'status', phase: 'auth', message: 'Проверяю аккаунт Microsoft…' });
        session = await auth.getSession(); // throws AuthError when login is required
      }

      // 4. Java.
      ctx.phase = 'java';
      send({ type: 'status', phase: 'java', message: 'Ищу подходящую Java…' });
      const requiredMajor = readRequiredJavaMajor(gameDir, meta.id, fsImpl);
      ctx.requiredJava = requiredMajor;
      const installs = await java.detectJava({ extraPath: s.javaPath });
      ctx.foundJava = installs.map((j) => j.major).join(', ') || 'нет';
      const chosen = java.pickJava(installs, requiredMajor, s.javaPath);
      if (!chosen) {
        const found = installs.length ? ` Найдено: ${installs.map((j) => j.major).join(', ')}.` : ' Java не найдена.';
        throw new GameError('JAVA_MISSING', `Для Minecraft ${meta.id} нужна Java ${requiredMajor}${requiredMajor <= 8 ? ' (именно 8)' : ' или новее'}.${found} Установите Java 64-bit (например, Eclipse Temurin) и повторите.`);
      }
      ctx.javaPath = chosen.path;
      ctx.javaVersion = chosen.version;

      // 5. Memory, validated against the real machine.
      const memory = ram.validateRam(s.ramGb, ram.getMemoryInfo(), { javaIs64Bit: chosen.is64Bit });
      if (!memory.ok) throw new GameError('RAM_INVALID', memory.error);
      for (const warning of memory.warnings) send({ type: 'warning', message: warning });

      // 6. Launch.
      ctx.phase = 'launching';
      send({ type: 'status', phase: 'launching', message: 'Запускаю игру…' });
      logger.info(`Launching ${meta.id} with Java ${chosen.version} (${chosen.path}), ${memory.valueGb} GB`);
      const child = await launcher.launch({
        gameDir,
        version: meta.id,
        javaPath: chosen.path,
        maxMemoryMb: memory.valueGb * 1024,
        minMemoryMb: Math.min(1024, memory.valueGb * 1024),
        session
      });
      running = { pid: child.pid };
      const gameCtx = { ...ctx, phase: 'game' };
      const recent = [];
      const pipe = (stream, level) => {
        if (!stream) return;
        stream.on('data', (chunk) => {
          for (const line of String(chunk).split(/\r?\n/)) {
            if (!line.trim()) continue;
            logger[level](`[game] ${line}`);
            recent.push(line);
            if (recent.length > OUTPUT_LINES) recent.shift();
          }
        });
      };
      pipe(child.stdout, 'info');
      pipe(child.stderr, 'warn');
      child.on('error', (err) => {
        running = null;
        const r = report(new GameError('LAUNCH_FAILED', 'Не удалось запустить процесс Java.', { cause: err }), { ...gameCtx, phase: 'launching' });
        send({ type: 'error', code: 'LAUNCH_FAILED', message: 'Не удалось запустить процесс Java.', report: r });
      });
      child.on('exit', (code) => {
        running = null;
        logger.info(`Game exited with code ${code}`);
        if (typeof code === 'number' && code !== 0) {
          const err = new GameError('GAME_EXIT', `Игра завершилась с кодом ${code}.`);
          const r = report(err, { ...gameCtx, exitCode: code, output: logger.safe(recent.join('\n')) });
          send({ type: 'exited', code, message: `Игра завершилась с кодом ${code}.`, report: r });
        } else {
          send({ type: 'exited', code, message: 'Игра закрыта.' });
        }
      });
      send({ type: 'status', phase: 'running', message: `Minecraft ${meta.id} запущен.`, pid: child.pid });
      return { version: meta.id, pid: child.pid };
    } catch (err) {
      if (err && typeof err === 'object' && err.code !== 'CANCELLED') report(err, ctx);
      throw err;
    } finally {
      busy = null;
    }
  }

  return {
    play,
    cancel() {
      if (!busy) return false;
      busy.abort.abort();
      return true;
    },
    state() {
      return { busy: Boolean(busy), running: Boolean(running), pid: running ? running.pid : null };
    }
  };
}

module.exports = { createGameService, GameError, isInstalled, readRequiredJavaMajor, MARKER };
