'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, safeStorage, session, shell } = require('electron');

const { Logger, Redactor } = require('./logger');
const { SettingsStore } = require('./settings');
const { BackgroundStore } = require('./backgrounds');
const { getMemoryInfo, validateRam } = require('./ram');
const java = require('./java');
const { VersionService } = require('./versions');
const { AuthService, isAllowedLoginUrl } = require('./auth');
const { createGameService } = require('./game');
const { createInstaller, createLauncher } = require('./adapters/xmcl');
const { registerIpc } = require('./ipc');
const { ErrorReporter } = require('./errors');

const INDEX_FILE = path.join(__dirname, '..', 'renderer', 'index.html');
const TRUSTED_URL = pathToFileURL(INDEX_FILE).href;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Hardening that applies to every window/session the app could ever create.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url !== TRUSTED_URL) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    const dataDir = app.getPath('userData');
    const redactor = new Redactor();
    const logger = new Logger({ dir: path.join(dataDir, 'logs'), redactor, echo: !app.isPackaged });
    const gameDir = path.join(dataDir, 'minecraft');
    const errorsDir = path.join(dataDir, 'errors');
    const reporter = new ErrorReporter({ dir: errorsDir, logger, appVersion: app.getVersion() });
    process.on('uncaughtException', (err) => { reporter.report(err, { phase: 'main' }); });
    process.on('unhandledRejection', (reason) => { reporter.report(reason instanceof Error ? reason : new Error(String(reason)), { phase: 'main' }); });

    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    const settings = new SettingsStore(dataDir);
    await settings.load();
    const backgrounds = new BackgroundStore(path.join(dataDir, 'backgrounds'));
    const versions = new VersionService({ cacheFile: path.join(dataDir, 'cache', 'version_manifest_v2.json') });
    const auth = new AuthService({
      dir: path.join(dataDir, 'auth'),
      safeStorage,
      logger,
      clientId: process.env.OBSCURA_MS_CLIENT_ID || null,
      openExternal: (url) => { if (isAllowedLoginUrl(url)) shell.openExternal(url); }
    });

    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    };

    const game = createGameService({
      settings, versions, auth, java,
      ram: { getMemoryInfo, validateRam },
      installer: createInstaller(),
      launcher: createLauncher({ launcherVersion: app.getVersion() }),
      gameDir, logger, reporter,
      emit: (event) => send('game:event', event)
    });

    const system = {
      async info() {
        const memory = getMemoryInfo();
        const installs = await java.detectJava({ extraPath: settings.get().javaPath });
        return {
          memory,
          java: installs.map((j) => ({ version: j.version, major: j.major, is64Bit: j.is64Bit, source: j.source })),
          secureStorage: safeStorage.isEncryptionAvailable(),
          platform: process.platform
        };
      }
    };

    registerIpc({
      ipcMain, trustedUrl: TRUSTED_URL, logger,
      services: {
        settings, backgrounds, versions, auth, game, system,
        emitAuthCode: (code) => send('auth:code', code),
        errors: {
          reporter,
          openFolder: async () => { require('node:fs').mkdirSync(errorsDir, { recursive: true }); return shell.openPath(errorsDir); }
        }
      }
    });

    mainWindow = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 760,
      minHeight: 560,
      backgroundColor: '#111315',
      show: false,
      title: 'Obscura — Minecraft Launcher',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        devTools: !app.isPackaged
      }
    });
    mainWindow.removeMenu();
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    await mainWindow.loadURL(TRUSTED_URL);
    logger.info(`Obscura started (data: ${dataDir})`);
  }).catch((err) => {
    console.error(err);
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
}
