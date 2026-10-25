'use strict';
// Orchestrates one "Play" press: resolve version -> install if needed ->
// check account -> pick Java -> validate RAM -> launch.
// All collaborators are injected so the flow can be tested without Electron,
// the network or Minecraft.
const fs = require('node:fs');
const path = require('node:path');
const { validatePatch } = require('./settings');

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const MARKER = '.obscura-installed';

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
  const { settings, versions, auth, java, ram, installer, launcher, gameDir, logger, emit, fsImpl = fs } = deps;
  let busy = null;      // { abort: AbortController }
  let running = null;   // { pid }

  const send = (event) => { try { emit(event); } catch { /* UI may be gone */ } };

  async function play(input) {
    if (busy) throw new GameError('BUSY', 'Подготовка к запуску уже идёт.');
    if (running) throw new GameError('RUNNING', 'Игра уже запущена.');
    const abort = new AbortController();
    busy = { abort };
    try {
      const { version } = validatePatch({ version: input && input.version });
      const s = settings.get();

      // 1. Resolve the requested version through Mojang's manifest.
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
          throw new GameError(err.code || 'VERSION', err.message);
        }
      }

      // 2. Install (first run of a version only; `repair` forces a re-check).
      if ((input && input.repair === true) ||!isInstalled(gameDir, meta.id, fsImpl)) {
        send({ type: 'status', phase: 'installing', message: `Устанавливаю Minecraft ${meta.id}…`, progress: null });
        try {
          await installer.install(meta, gameDir, {
            signal: abort.signal,
            onProgress: (p) => send({ type: 'progress', phase: 'installing', ...p })
          });
        } catch (err) {
          if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
          logger.error(err);
          throw new GameError('INSTALL_FAILED', `Не удалось установить Minecraft ${meta.id}: ${logger.safe(err.message || err)}`);
        }
        if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
        if (!fsImpl.existsSync(path.join(gameDir, 'versions', meta.id, `${meta.id}.jar`))) {
          throw new GameError('INSTALL_FAILED', 'Установка завершилась, но файлы игры не найдены.');
        }
        await fsImpl.promises.writeFile(path.join(gameDir, 'versions', meta.id, MARKER), new Date().toISOString());
      }

      // 3. Account.
      send({ type: 'status', phase: 'auth', message: 'Проверяю аккаунт Microsoft…' });
      const session = await auth.getSession(); // throws AuthError when login is required

      // 4. Java.
      send({ type: 'status', phase: 'java', message: 'Ищу подходящую Java…' });
      const requiredMajor = readRequiredJavaMajor(gameDir, meta.id, fsImpl);
      const installs = await java.detectJava({ extraPath: s.javaPath });
      const chosen = java.pickJava(installs, requiredMajor, s.javaPath);
      if (!chosen) {
        const found = installs.length ? ` Найдено: ${installs.map((j) => j.major).join(', ')}.` : ' Java не найдена.';
        throw new GameError('JAVA_MISSING', `Для Minecraft ${meta.id} нужна Java ${requiredMajor}${requiredMajor <= 8 ? ' (именно 8)' : ' или новее'}.${found} Установите Java 64-bit (например, Eclipse Temurin) и повторите.`);
      }

      // 5. Memory, validated against the real machine.
      const memory = ram.validateRam(s.ramGb, ram.getMemoryInfo(), { javaIs64Bit: chosen.is64Bit });
      if (!memory.ok) throw new GameError('RAM_INVALID', memory.error);
      for (const warning of memory.warnings) send({ type: 'warning', message: warning });

      // 6. Launch.
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
      const pipe = (stream, level) => {
        if (!stream) return;
        stream.on('data', (chunk) => {
          for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) logger[level](`[game] ${line}`);
        });
      };
      pipe(child.stdout, 'info');
      pipe(child.stderr, 'warn');
      child.on('error', (err) => {
        logger.error(err);
        running = null;
        send({ type: 'error', code: 'LAUNCH_FAILED', message: 'Не удалось запустить процесс Java.' });
      });
      child.on('exit', (code) => {
        running = null;
        logger.info(`Game exited with code ${code}`);
        send({ type: 'exited', code, message: code === 0 ? 'Игра закрыта.' : `Игра завершилась с кодом ${code}. Подробности — в логе.` });
      });
      send({ type: 'status', phase: 'running', message: `Minecraft ${meta.id} запущен.`, pid: child.pid });
      return { version: meta.id, pid: child.pid };
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
