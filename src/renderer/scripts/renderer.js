// Obscura renderer. It has no access to Node.js: everything that touches the
// system goes through the small `window.obscura` API exposed by preload.js.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const api = window.obscura;

const toast = $('#toast');
let toastTimer;
function showToast(message, ms = 3600, kind = '') {
  toast.textContent = message;
  toast.classList.remove('error', 'success');
  if (kind) toast.classList.add(kind);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), ms);
}
const showError = (message, ms = 6000) => showToast(message, ms, 'error');

// ---------------------------------------------------------------- numbered errors
const errorDialog = $('#errorDialog');
let shownReport = null;
function openErrorDialog(report) {
  shownReport = report;
  $('#errorCode').textContent = report.code;
  $('#errorNumber').textContent = `№${report.number}`;
  $('#errorTitle').textContent = report.title;
  $('#errorCause').textContent = report.cause;
  $('#errorFix').textContent = report.fix;
  const detail = report.detail ? String(report.detail) : '';
  $('#errorDetail').textContent = detail;
  $('#errorDetailBox').hidden = !detail;
  $('#errorFile').textContent = report.file ? `Подробный отчёт: errors\\${report.file}` : 'Отчёт не удалось сохранить на диск.';
  if (!errorDialog.open) errorDialog.showModal();
}
function reportText(r) {
  return [`${r.code} №${r.number} — ${r.title}`, `Что случилось: ${r.cause}`, `Что делать: ${r.fix}`, r.detail ? `Причина: ${r.detail}` : '', r.file ? `Отчёт: ${r.file}` : ''].filter(Boolean).join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* permission denied: use the legacy path */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
$('#errorClose').addEventListener('click', () => errorDialog.close());
$('#errorCopy').addEventListener('click', async () => {
  if (!shownReport) return;
  showToast((await copyText(reportText(shownReport))) ? 'Описание ошибки скопировано.' : 'Не удалось скопировать: выделите текст вручную.', 2600, 'success');
});
async function openErrorsFolder() {
  try { await call(api.errors.openFolder()); } catch (err) { fail(err); }
}
$('#errorOpenFolder').addEventListener('click', openErrorsFolder);

/** Show a failure: numbered window for serious errors, short toast with the code for minor ones. */
function fail(err, ms = 6000) {
  const report = err && err.report;
  if (!report) return showError(err.message, ms);
  refreshErrorList();
  if (report.dialog) return openErrorDialog(report);
  showError(`[${report.code}] ${err.message}`, ms);
}

/** Unwrap { ok, data } / { ok:false, error } returned by the main process. */
async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) {
    const error = new Error((res && res.error && res.error.message) || 'Неизвестная ошибка.');
    error.code = res && res.error && res.error.code;
    error.report = (res && res.error && res.error.report) || null; // numbered error report from the main process
    throw error;
  }
  return res.data;
}

// ---------------------------------------------------------------- navigation
const pageNames = { home: 'Главная', instances: 'Сборки', news: 'Новости', settings: 'Настройки' };
$$('.nav-item[data-page]').forEach((button) => {
  button.addEventListener('click', () => {
    const page = button.dataset.page;
    $$('.nav-item[data-page]').forEach((item) => item.classList.toggle('active', item === button));
    $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
    $('#pageCrumb').textContent = pageNames[page] || 'Главная';
  });
});
$$('.back-home').forEach((button) => button.addEventListener('click', () => $('[data-page="home"]').click()));
$('#minimizeHint').addEventListener('click', () => showToast('Obscura Beta 0.3.1 — лаунчер Minecraft: Java Edition.'));

if (!api) {
  showError('Интерфейс запущен без Electron: запуск игры недоступен.', 8000);
  $('#playButton').disabled = true;
  throw new Error('window.obscura is not available');
}

// ---------------------------------------------------------------- news (release notes)
const tagLabels = { fixed: 'ИСПРАВЛЕНО', new: 'НОВОЕ', better: 'УЛУЧШЕНО' };
function renderNews() {
  const list = $('#newsList');
  if (!list || typeof OBSCURA_NEWS === 'undefined') return;
  const cards = OBSCURA_NEWS.map((entry) => {
    const card = document.createElement('article');
    card.className = 'news-card';
    const head = document.createElement('div');
    head.className = 'news-head';
    const version = document.createElement('span');
    version.className = 'news-version';
    version.textContent = `v${entry.version}`;
    const date = document.createElement('span');
    date.className = 'news-date';
    date.textContent = entry.date;
    const title = document.createElement('h2');
    title.className = 'news-title';
    title.textContent = entry.title;
    head.append(version, date, title);
    const items = document.createElement('ul');
    items.className = 'news-items';
    entry.items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'news-item';
      const tag = document.createElement('span');
      tag.className = `news-tag ${tagLabels[item.tag] ? item.tag : 'new'}`;
      tag.textContent = tagLabels[item.tag] || tagLabels.new;
      const text = document.createElement('span');
      text.textContent = item.text;
      li.append(tag, text);
      items.append(li);
    });
    card.append(head, items);
    return card;
  });
  list.replaceChildren(...cards);
}
renderNews();

// ---------------------------------------------------------------- settings: RAM + version
const ramRange = $('#ramRange');
const ramValue = $('#ramValue');
const versionSelect = $('#versionSelect');
let currentSettings = null;

ramRange.addEventListener('input', () => { ramValue.textContent = ramRange.value; });
ramRange.addEventListener('change', async () => {
  const wanted = Number(ramRange.value);
  try {
    currentSettings = await call(api.settings.update({ ramGb: wanted }));
  } catch (err) {
    fail(err);
    ramRange.value = currentSettings ? currentSettings.ramGb : 4;
    ramValue.textContent = ramRange.value;
  }
});

versionSelect.addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ version: versionSelect.value }));
  } catch (err) {
    fail(err);
    versionSelect.value = currentSettings ? currentSettings.version : 'release';
  }
});

function option(value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

async function loadVersions() {
  const note = $('#versionNote');
  try {
    const data = await call(api.versions.list());
    const releases = data.versions.filter((v) => v.type === 'release');
    versionSelect.replaceChildren(
      option('release', `Последний релиз (${data.latest.release})`),
      option('snapshot', `Последний snapshot (${data.latest.snapshot})`)
    );
    const group = document.createElement('optgroup');
    group.label = 'Релизы';
    releases.forEach((v) => group.append(option(v.id, v.id)));
    versionSelect.append(group);
    note.textContent = data.source === 'network'
      ? `Список Mojang · релизов: ${releases.length}`
      : 'Нет сети: список из кэша. Установленные версии запустятся.';
  } catch (err) {
    note.textContent = 'Не удалось загрузить список версий: доступны только встроенные пункты.';
  }
  const wanted = currentSettings ? currentSettings.version : 'release';
  versionSelect.value = [...versionSelect.options].some((o) => o.value === wanted) ? wanted : 'release';
}

// ---------------------------------------------------------------- system info (RAM bounds, Java)
async function loadSystem() {
  try {
    const info = await call(api.system.info());
    ramRange.min = String(info.memory.minGb);
    ramRange.max = String(info.memory.maxGb);
    const labels = $$('.range-labels span');
    if (labels.length === 2) { labels[0].textContent = `${info.memory.minGb} GB`; labels[1].textContent = `${info.memory.maxGb} GB`; }
    $('#ramNote').textContent = `В системе ${info.memory.totalGb} GB · свободно ${info.memory.freeGb} GB · максимум ${info.memory.maxGb} GB`;
    if (currentSettings && currentSettings.ramGb > info.memory.maxGb) {
      const was = currentSettings.ramGb;
      currentSettings = await call(api.settings.update({ ramGb: info.memory.maxGb }));
      showToast(`Память уменьшена с ${was} до ${info.memory.maxGb} GB: в этом компьютере ${info.memory.totalGb} GB.`, 6000);
    }
    if (currentSettings) ramRange.value = String(currentSettings.ramGb);
    ramValue.textContent = ramRange.value;
    const javaInfo = $('#javaInfo');
    const badge = $('#javaBadge');
    if (info.java.length) {
      javaInfo.textContent = info.java.map((j) => `Java ${j.major} (${j.is64Bit ? '64-bit' : '32-bit'})`).join(' · ');
      badge.textContent = 'НАЙДЕНА';
    } else {
      javaInfo.textContent = 'Java не найдена. Установите Java 17+ (для 1.18+) или Java 8 (для старых версий).';
      badge.textContent = 'НЕТ';
    }
  } catch (err) {
    $('#javaInfo').textContent = err.message;
  }
}

// ---------------------------------------------------------------- backgrounds
const builtinBackgrounds = [
  { id: 'builtin-1', name: 'BACKGROUND 01', url: './assets/backgrounds/background-01.svg' },
  { id: 'builtin-2', name: 'BACKGROUND 02', url: './assets/backgrounds/background-02.svg' },
  { id: 'builtin-3', name: 'BACKGROUND 03', url: './assets/backgrounds/background-03.svg' }
];
let currentBackground = 'builtin-1';
function applyBackground(url, name) {
  const hero = $('#heroCard');
  hero.style.backgroundImage = `url("${url}")`;
  $('#backgroundName').textContent = name;
  hero.classList.remove('bg-swap');
  void hero.offsetWidth; // restart the CSS animation
  hero.classList.add('bg-swap');
}
function showBackground(state) {
  currentBackground = state.id;
  if (state.id === 'custom' && state.dataUrl) return applyBackground(state.dataUrl, 'CUSTOM BACKGROUND');
  const item = builtinBackgrounds.find((b) => b.id === state.id) || builtinBackgrounds[0];
  currentBackground = item.id;
  applyBackground(item.url, item.name);
}
async function nextBackground() {
  const index = builtinBackgrounds.findIndex((b) => b.id === currentBackground);
  const item = builtinBackgrounds[(index + 1) % builtinBackgrounds.length];
  try {
    await call(api.background.select(item.id));
    showBackground({ id: item.id });
    showToast(`Фон изменён: ${item.name.toLowerCase()}.`);
  } catch (err) { fail(err); }
}
$('#changeBackgroundButton').addEventListener('click', nextBackground);
$('#settingsBackgroundButton').addEventListener('click', nextBackground);
$('#authModeSelect').addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ authMode: $('#authModeSelect').value }));
    $('#localUsernameRow').hidden = currentSettings.authMode !== 'local';
    const status = await call(api.auth.status());
    renderAccount(status);
    showToast(currentSettings.authMode === 'local' ? 'Включён локальный офлайн-профиль.' : 'Включён режим Microsoft.');
  } catch (err) { fail(err); $('#authModeSelect').value = currentSettings ? currentSettings.authMode : 'microsoft'; }
});
$('#saveLocalUsernameButton').addEventListener('click', async () => {
  try {
    currentSettings = await call(api.settings.update({ localUsername: $('#localUsernameInput').value.trim() }));
    $('#localUsernameInput').value = currentSettings.localUsername;
    renderAccount(await call(api.auth.status()));
    showToast('Ник локального профиля сохранён.');
  } catch (err) { fail(err); if (currentSettings) $('#localUsernameInput').value = currentSettings.localUsername; }
});
$('#addAccountButton').addEventListener('click', () => login());
$('#accountSelect').addEventListener('change', async () => {
  if (!$('#accountSelect').value) return;
  try { renderAccount(await call(api.auth.select($('#accountSelect').value))); showToast('Активный аккаунт изменён.'); }
  catch (err) { fail(err); renderAccount(await call(api.auth.status())); }
});
$('#removeAccountButton').addEventListener('click', async () => {
  const uuid = $('#accountSelect').value;
  if (!uuid) return showToast('Сначала выбери аккаунт.');
  if (!window.confirm('Удалить выбранный аккаунт из списка Obscura?')) return;
  try { renderAccount(await call(api.auth.remove(uuid))); showToast('Аккаунт удалён из списка.'); }
  catch (err) { fail(err); }
});

const backgroundFileInput = $('#backgroundFileInput');
const MAX_BACKGROUND_SIDE = 2560;

/**
 * Decode any image the browser understands (PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ...),
 * shrink it to a sensible size and re-encode it as WebP. The main process then verifies
 * the bytes again, so the stored file is always a small, known-good image.
 */
async function imageFileToWebp(file) {
  if (!file || file.size === 0) throw new Error('Файл пустой.');
  if (file.size > 80 * 1024 * 1024) throw new Error('Файл слишком большой (максимум 80 MB).');
  let source;
  let width;
  let height;
  let cleanup = () => {};
  try {
    source = await createImageBitmap(file);
    width = source.width;
    height = source.height;
    cleanup = () => source.close();
  } catch {
    const url = URL.createObjectURL(file); // SVG and some formats decode only through <img>
    cleanup = () => URL.revokeObjectURL(url);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
      width = img.naturalWidth || 1920;
      height = img.naturalHeight || 1080;
    } catch {
      cleanup();
      throw new Error('Не удалось открыть файл как изображение. Попробуйте PNG, JPEG, WebP, GIF, BMP, AVIF или SVG.');
    }
  }
  try {
    const longest = Math.max(width, height);
    let scale = Math.min(1, MAX_BACKGROUND_SIDE / longest);
    if (file.type === 'image/svg+xml' && longest < 1600) scale = 1600 / longest; // keep vectors crisp
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111315'; // transparent pixels sit on the launcher's own background colour
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob || blob.type !== 'image/webp') throw new Error('Не удалось сохранить изображение.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    cleanup();
  }
}

async function setBackgroundFromFile(file) {
  try {
    const bytes = await imageFileToWebp(file);
    const state = await call(api.background.setCustom(bytes)); // verified by content in the main process
    showBackground(state);
    showToast('Свой фон сохранён.', 3200, 'success');
  } catch (err) { fail(err); }
}

$('#changeBackgroundButton').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  backgroundFileInput.click();
});
$('#pickBackgroundButton').addEventListener('click', () => backgroundFileInput.click());
$('#resetBackgroundButton').addEventListener('click', async () => {
  try {
    showBackground(await call(api.background.clear()));
    showToast('Возвращён встроенный фон.');
  } catch (err) { fail(err); }
});
backgroundFileInput.addEventListener('change', () => {
  const file = backgroundFileInput.files && backgroundFileInput.files[0];
  backgroundFileInput.value = '';
  if (file) setBackgroundFromFile(file);
});

// Drag & drop an image onto the hero card. Drops anywhere else must never navigate the window.
const heroCard = $('#heroCard');
const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (hasFiles(event)) event.preventDefault(); });
heroCard.addEventListener('dragover', (event) => { if (hasFiles(event)) heroCard.classList.add('drop'); });
['dragleave', 'dragend'].forEach((name) => heroCard.addEventListener(name, () => heroCard.classList.remove('drop')));
heroCard.addEventListener('drop', (event) => {
  heroCard.classList.remove('drop');
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) setBackgroundFromFile(file);
});

// ---------------------------------------------------------------- account
const accountButton = $('#accountButton');
const authDialog = $('#authDialog');
let loginInProgress = false;

function renderAccount(status) {
  const localMode = currentSettings && currentSettings.authMode === 'local';
  const name = localMode ? (currentSettings.localUsername || 'Player') : (status.profile ? status.profile.name : 'Гость');
  $('#profileName').textContent = name;
  $('#profileStatus').textContent = localMode ? 'ОФЛАЙН · без лицензии' : (status.profile ? 'MICROSOFT · лицензия' : 'Не выполнен вход');
  $('#avatarLetter').textContent = name && name !== 'Гость' ? name.charAt(0).toUpperCase() : '?';
  accountButton.title = status.accounts && status.accounts.length ? 'Управление аккаунтами' : 'Войти через Microsoft';
  renderAccountList(status);
  renderHomeProfileSelect(status);
}

function renderAccountList(status) {
  const select = $('#accountSelect');
  if (!select) return;
  const accounts = Array.isArray(status.accounts) ? status.accounts : (status.profile ? [status.profile] : []);
  select.replaceChildren(...(accounts.length ? accounts.map(a => {
    const o = option(a.uuid, `${a.name} — MICROSOFT / лицензия`);
    if (status.profile && status.profile.uuid === a.uuid) o.selected = true;
    return o;
  }) : [option('', 'Нет аккаунтов Microsoft')]));
}

function renderHomeProfileSelect(status) {
  const select = $('#profileSelect');
  if (!select) return;
  const accounts = Array.isArray(status.accounts) ? status.accounts : (status.profile ? [status.profile] : []);
  const localName = currentSettings && currentSettings.localUsername ? currentSettings.localUsername : 'Player';
  const options = [option('local', `${localName} — ОФЛАЙН / без лицензии`)];
  for (const account of accounts) options.push(option(`microsoft:${account.uuid}`, `${account.name} — MICROSOFT / лицензия`));
  select.replaceChildren(...options);
  const localMode = currentSettings && currentSettings.authMode === 'local';
  select.value = localMode ? 'local' : (status.profile ? `microsoft:${status.profile.uuid}` : 'local');
}

$('#profileSelect').addEventListener('change', async () => {
  const value = $('#profileSelect').value;
  try {
    if (value === 'local') {
      currentSettings = await call(api.settings.update({ authMode: 'local' }));
      $('#authModeSelect').value = 'local';
      $('#localUsernameRow').hidden = false;
      renderAccount(await call(api.auth.status()));
      showToast('Выбран офлайн-профиль без лицензии.');
      return;
    }
    if (value.startsWith('microsoft:')) {
      const uuid = value.slice('microsoft:'.length);
      const status = await call(api.auth.select(uuid));
      currentSettings = await call(api.settings.update({ authMode: 'microsoft' }));
      $('#authModeSelect').value = 'microsoft';
      $('#localUsernameRow').hidden = true;
      renderAccount(status);
      showToast(`Выбран Microsoft-аккаунт: ${status.profile ? status.profile.name : 'аккаунт'}.`);
    }
  } catch (err) {
    fail(err);
    renderAccount(await call(api.auth.status()));
  }
});

api.auth.onCode(({ userCode, url }) => {
  $('#authCode').textContent = userCode;
  $('#authUrl').textContent = url;
  if (!authDialog.open) authDialog.showModal();
});
$('#authCancel').addEventListener('click', async () => {
  await api.auth.cancel();
  if (authDialog.open) authDialog.close();
});
authDialog.addEventListener('cancel', () => { api.auth.cancel(); });

async function login() {
  if (loginInProgress) return false;
  loginInProgress = true;
  try {
    const profile = await call(api.auth.login());
    currentSettings = await call(api.settings.update({ authMode: 'microsoft' }));
    $('#authModeSelect').value = 'microsoft';
    $('#localUsernameRow').hidden = true;
    const status = await call(api.auth.status());
    renderAccount(status && status.profile ? status : { loggedIn: true, profile });
    showToast(`Выбран Microsoft-аккаунт: ${profile.name}.`);
    return true;
  } catch (err) {
    if (err.code !== 'CANCELLED') fail(err);
    return false;
  } finally {
    loginInProgress = false;
    if (authDialog.open) authDialog.close();
    $('#authCode').textContent = '—';
  }
}
accountButton.addEventListener('click', async () => {
  const status = await call(api.auth.status());
  if (!status.loggedIn) return login();
  $('[data-page="settings"]').click();
  $('#accountSelect').focus();
});
$('.profile-card .avatar').addEventListener('click', () => accountButton.click());

// ---------------------------------------------------------------- play / progress
const playButton = $('#playButton');
const cancelButton = $('#cancelButton');
const progressBox = $('#launchProgress');
const progressText = $('#launchProgressText');
const progressBar = $('#launchProgressBar');

const playLabel = $('#playLabel');
function setBusy(busy) {
  playButton.disabled = busy;
  playLabel.textContent = busy ? 'Подготовка…' : 'Запустить игру';
  progressBox.hidden = !busy;
  if (!busy) { cancelButton.hidden = true; progressBar.classList.remove('indeterminate'); progressBar.style.width = '0'; }
}
function setProgress(text, percent) {
  progressBox.hidden = false;
  progressText.textContent = text;
  if (typeof percent === 'number') {
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = `${percent}%`;
  } else {
    progressBar.style.width = '';
    progressBar.classList.add('indeterminate');
  }
}

api.game.onEvent((event) => {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'status') {
    cancelButton.hidden = event.phase !== 'installing';
    setProgress(String(event.message || ''), event.phase === 'running' ? 100 : null);
    if (event.phase === 'running') setTimeout(() => setBusy(false), 1800);
  } else if (event.type === 'progress') {
    const label = typeof event.percent === 'number' ? `Установка… ${event.percent}%` : 'Установка…';
    setProgress(label, typeof event.percent === 'number' ? event.percent : null);
  } else if (event.type === 'warning') {
    showToast(String(event.message), 6000);
  } else if (event.type === 'error' || event.type === 'exited') {
    setBusy(false);
    if (event.report) {
      refreshErrorList();
      if (event.report.dialog) return openErrorDialog(event.report);
    }
    showToast(String(event.message || ''), 6000, event.type === 'error' || event.code ? 'error' : '');
  }
});

playButton.addEventListener('click', async () => {
  setBusy(true);
  setProgress('Подготовка…', null);
  try {
    await call(api.game.play({ version: versionSelect.value }));
  } catch (err) {
    setBusy(false);
    if (err.code === 'LOGIN_REQUIRED') {
      showToast('Нужно войти в аккаунт Microsoft.', 3000);
      if (await login()) playButton.click();
      return;
    }
    if (err.code === 'CANCELLED') return showToast('Отменено.');
    fail(err);
  }
});
cancelButton.addEventListener('click', () => { api.game.cancel(); });

// ---------------------------------------------------------------- error journal (Settings)
async function refreshErrorList() {
  try {
    const items = await call(api.errors.list());
    const list = $('#errorList');
    $('#errorSummary').textContent = items.length
      ? `Последние ошибки (${items.length}). Нажмите на строку, чтобы увидеть причину и что делать.`
      : 'Ошибок пока не было.';
    list.replaceChildren(...items.slice(0, 5).map((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'error-row';
      const code = document.createElement('span'); code.className = 'e-code'; code.textContent = item.code;
      const num = document.createElement('span'); num.className = 'e-num'; num.textContent = `№${item.number}`;
      const title = document.createElement('span'); title.className = 'e-title'; title.textContent = item.title;
      const date = document.createElement('span'); date.className = 'e-date'; date.textContent = item.date;
      row.append(code, num, title, date);
      row.addEventListener('click', () => openErrorDialog({ ...item, detail: '' }));
      return row;
    }));
  } catch { /* the journal is optional */ }
}
$('#openErrorsButton').addEventListener('click', openErrorsFolder);

// ---------------------------------------------------------------- startup
(async function init() {
  try {
    currentSettings = await call(api.settings.get());
    $('#authModeSelect').value = currentSettings.authMode || 'microsoft';
    $('#localUsernameInput').value = currentSettings.localUsername || 'Player';
    $('#localUsernameRow').hidden = (currentSettings.authMode || 'microsoft') !== 'local';
    ramRange.value = String(currentSettings.ramGb);
    ramValue.textContent = ramRange.value;
    showBackground(await call(api.background.get()));
    renderAccount(await call(api.auth.status()));
    const state = await call(api.game.state());
    if (state.running) setProgress('Игра запущена.', 100);
  } catch (err) { fail(err); }
  await loadSystem();
  await loadVersions();
  refreshErrorList();
})();
