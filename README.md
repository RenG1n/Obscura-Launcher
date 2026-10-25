# Obscura — Minecraft Java Launcher

Electron-лаунчер. Дизайн (матовый тёмный, лаймовый акцент, без градиентов) сохранён.

## Windows: команды

Нужны [Node.js 22 LTS](https://nodejs.org) и интернет. В PowerShell, в папке проекта:

```powershell
npm install          # зависимости (Electron, @xmcl/core, @xmcl/installer, prismarine-auth, electron-builder)
npm test             # 46 автотестов
npm run doctor       # проверка библиотек, манифеста Mojang, Java и памяти на вашем ПК
npm start            # запуск лаунчера
npm run dist         # установщик: dist\Obscura-Setup-0.2.0.exe
npm run dist:portable  # переносимый .exe: dist\Obscura-Portable-0.2.0.exe
npm run dist:all     # оба сразу
```

Первая проверка на реальной машине (скачает игру во временную папку, ~0.5 GB):

```powershell
npm run doctor -- --install 1.21.8
```

Если `npm install` в PowerShell пишет «running scripts is disabled», выполните один раз `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (или используйте `npm.cmd` вместо `npm`).

Если `npm run dist` падает с «Cannot create symbolic link» — включите «Режим разработчика» Windows
(Параметры → Для разработчиков) или запустите PowerShell от администратора.

## Структура

| Файл | Назначение |
|---|---|
| `src/main/main.js` | Окно Electron: `contextIsolation`, `sandbox`, `nodeIntegration: false`, запрет навигации/окон/разрешений |
| `src/preload/preload.js` | Единственный мост в страницу: `window.obscura` (замороженный объект с 14 методами) |
| `src/main/ipc.js` | Все IPC-каналы: проверка отправителя, валидация, ошибки без стеков |
| `src/main/versions.js` | Версии из официального манифеста Mojang, кэш на диске, разрешены только https-адреса Mojang |
| `src/main/game.js` | Нажатие «Запустить»: версия → установка → аккаунт → Java → RAM → запуск; отмена; логи |
| `src/main/adapters/xmcl.js` | Тонкая обёртка над `@xmcl/installer` и `@xmcl/core` (аргументы запуска берутся из JSON Mojang) |
| `src/main/auth.js` | Вход Microsoft через `prismarine-auth`, токены шифруются `safeStorage` (DPAPI) |
| `src/main/{settings,ram,java,backgrounds,logger}.js` | Настройки, проверка RAM, поиск Java, свой фон, лог с маскированием токенов |
| `src/renderer/*` | Исходный интерфейс; `renderer.js` теперь вызывает `window.obscura` |
| `scripts/doctor.js` | Самопроверка на реальной машине |
| `test/*.test.js` | Автотесты |

Данные пользователя: `%APPDATA%\Obscura\` (настройки, фон, `minecraft\`, `logs\launcher.log`, `auth\`).

## Вход Microsoft

Используется Microsoft device-code: лаунчер показывает код и открывает `microsoft.com/link`, пароль в лаунчер не вводится.
По умолчанию `prismarine-auth` использует общедоступный идентификатор приложения Xbox. Для собственной сборки для других людей
зарегистрируйте приложение в Azure и получите одобрение Mojang, затем задайте его перед запуском:

```powershell
$env:OBSCURA_MS_CLIENT_ID = "ваш-client-id"; npm start
```

## Что проверено, а что нет

Проверено автотестами и в Chromium (Linux, заглушки вместо сети и библиотек): валидация настроек и RAM, разбор манифеста,
оркестрация запуска (псевдонимы release/snapshot, отмена, повторный запуск, офлайн, Java 8/17/21, 32-bit), IPC-граница,
сохранение фона, шифрование кэша токенов, маскирование токенов в логах, весь интерфейс.

**Подтверждено на Windows владельцем проекта:** `npm install`, `npm run doctor` («критических проблем нет»), `npm start` (окно открывается).

**Пока не подтверждено:** скачивание и запуск игры, вход в аккаунт Microsoft, сборка `.exe`. Если вы нашли ошибку, откройте issue и приложите последние строки `%APPDATA%\Obscura\logs\launcher.log` (токены в нём замаскированы).

## Известные ограничения

- Нет автоустановки Java: если нужной версии нет, лаунчер говорит, какая нужна. Находит Java в PATH, JAVA_HOME, Program Files и в папке официального лаунчера.
- Запуск только с лицензионным Microsoft-аккаунтом.
- Google Fonts по-прежнему грузятся из интернета (без сети — системный шрифт).
- Нет иконки приложения (используется стандартная Electron).
- `@xmcl/core` и `@xmcl/installer` закреплены на 2.15.1 и 6.1.2: последние версии этих пакетов опубликованы с зависимостью `workspace:`, которую npm не устанавливает. `prismarine-auth`, `electron` и `electron-builder` указаны как `latest` — после установки сохраните `package-lock.json` в репозитории.

## Лицензия и права

Лицензия исходного кода не выбрана — добавьте файл `LICENSE` на своё усмотрение. Проект не связан с Mojang Studios,
Microsoft и не одобрен ими. Minecraft — торговая марка Mojang Studios. Лаунчер запускает игру только для аккаунтов
с купленной лицензией Minecraft: Java Edition.
