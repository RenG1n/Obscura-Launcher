// Obscura renderer. It has no access to Node.js: everything that touches the
// system goes through the small `window.obscura` API exposed by preload.js.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const api = window.obscura;

const toast = $('#toast');
let toastTimer;
function showToast(message, ms = 3600) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), ms);
}

/** Unwrap { ok, data } / { ok:false, error } returned by the main process. */
async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) {
    const error = new Error((res && res.error && res.error.message) || 'Неизвестная ошибка.');
    error.code = res && res.error && res.error.code;
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
$('#minimizeHint').addEventListener('click', () => showToast('Obscura 0.2.0 — лаунчер Minecraft: Java Edition.'));

if (!api) {
  showToast('Интерфейс запущен без Electron: запуск игры недоступен.', 8000);
  $('#playButton').disabled = true;
  throw new Error('window.obscura is not available');
}

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
    showToast(err.message);
    ramRange.value = currentSettings ? currentSettings.ramGb : 4;
    ramValue.textContent = ramRange.value;
  }
});

versionSelect.addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ version: versionSelect.value }));
  } catch (err) {
    showToast(err.message);
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
  $('#heroCard').style.backgroundImage = `url("${url}")`;
  $('#backgroundName').textContent = name;
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
  } catch (err) { showToast(err.message); }
}
$('#changeBackgroundButton').addEventListener('click', nextBackground);
$('#settingsBackgroundButton').addEventListener('click', nextBackground);

const backgroundFileInput = $('#backgroundFileInput');
$('#changeBackgroundButton').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  backgroundFileInput.click();
});
backgroundFileInput.addEventListener('change', async () => {
  const file = backgroundFileInput.files && backgroundFileInput.files[0];
  backgroundFileInput.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return showToast('Файл слишком большой (максимум 8 MB).');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const state = await call(api.background.setCustom(bytes)); // type is verified by content in the main process
    showBackground(state);
    showToast('Свой фон сохранён.');
  } catch (err) { showToast(err.message); }
});

// ---------------------------------------------------------------- account
const accountButton = $('#accountButton');
const authDialog = $('#authDialog');
let loginInProgress = false;

function renderAccount(status) {
  const name = status.loggedIn ? status.profile.name : 'Гость';
  $('#profileName').textContent = name;
  $('#profileStatus').textContent = status.loggedIn ? 'Microsoft' : 'Не выполнен вход';
  $('#avatarLetter').textContent = status.loggedIn ? name.charAt(0).toUpperCase() : '?';
  accountButton.title = status.loggedIn ? 'Выйти из аккаунта' : 'Войти через Microsoft';
}

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
    renderAccount({ loggedIn: true, profile });
    showToast(`Вы вошли как ${profile.name}.`);
    return true;
  } catch (err) {
    if (err.code !== 'CANCELLED') showToast(err.message, 6000);
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
  if (window.confirm(`Выйти из аккаунта ${status.profile.name}?`)) {
    renderAccount(await call(api.auth.logout()));
    showToast('Вы вышли из аккаунта.');
  }
});
$('.profile-card .avatar').addEventListener('click', () => accountButton.click());

// ---------------------------------------------------------------- play / progress
const playButton = $('#playButton');
const cancelButton = $('#cancelButton');
const progressBox = $('#launchProgress');
const progressText = $('#launchProgressText');
const progressBar = $('#launchProgressBar');

function setBusy(busy) {
  playButton.disabled = busy;
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
    showToast(String(event.message || ''), 6000);
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
    showToast(err.message, 9000);
  }
});
cancelButton.addEventListener('click', () => { api.game.cancel(); });

// ---------------------------------------------------------------- startup
(async function init() {
  try {
    currentSettings = await call(api.settings.get());
    ramRange.value = String(currentSettings.ramGb);
    ramValue.textContent = ramRange.value;
    showBackground(await call(api.background.get()));
    renderAccount(await call(api.auth.status()));
    const state = await call(api.game.state());
    if (state.running) setProgress('Игра запущена.', 100);
  } catch (err) { showToast(err.message); }
  await loadSystem();
  await loadVersions();
})();
