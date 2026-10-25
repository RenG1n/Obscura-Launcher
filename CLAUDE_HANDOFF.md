# Obscura Launcher — handoff to Claude

This is a **front-end concept UI**, not a functional Minecraft launcher yet.

## Current files
- `index.html`: app layout and page sections
- `styles/main.css`: matte dark styling, responsive layout, no CSS gradients
- `scripts/renderer.js`: demo navigation, RAM slider, version selector, background switching and UI toast messages
- `assets/backgrounds/`: three simple local SVG backgrounds

## Important current behavior
- The Play button only displays a demo message. It does **not** launch Minecraft.
- The RAM slider changes the selected value in the UI. It does **not** set Java memory yet.
- Version options are UI choices only. They are not verified against Mojang's version manifest.
- Background selection rotates between three built-in backgrounds. Right-clicking the change-background button opens an image picker in a regular browser; this should be redesigned for Electron and persisted safely.
- Profile/account and instance screens are placeholders.
- Google Fonts are loaded from the internet; replace with bundled fonts if fully offline operation is required.

## Suggested implementation plan
1. Inspect the current UI and preserve its visual design unless asked otherwise.
2. Set up Electron (or recommend Tauri if justified) and package scripts.
3. Keep `contextIsolation: true`, `nodeIntegration: false`, and expose only a small, validated API from `preload.js`.
4. Add a narrow IPC API for reading/writing validated settings, selecting a background, checking Java, installing supported Minecraft versions, and launching the game.
5. Implement version metadata/downloads and Java launch arguments using a maintained library where possible. Do not invent Minecraft file URLs or launch arguments.
6. Use official Microsoft OAuth flow for Microsoft account authentication. Do not ask the user to paste passwords or client secrets into the UI.
7. Validate RAM against available system memory and show a helpful warning if the requested amount is unreasonable.
8. Add error handling, progress indicators, cancellation, and logs with sensitive tokens redacted.
9. Test installation and launch on a clean Windows machine, then package the `.exe`.

## Interface integration contract
- Keep IDs used by the UI: `playButton`, `versionSelect`, `ramRange`, `ramValue`, `changeBackgroundButton`, `backgroundFileInput`, `toast`.
- Replace the demo listener for `playButton` with a call through the preload API. Do not expose unrestricted Node.js APIs to the renderer.
- Keep the UI's `versionSelect` value mapping explicit: `release`, `1.21.8`, `1.21.5`, `1.20.4`, `1.19.4`, `snapshot`.
- The selected RAM value is in GB. Validate it in the main process before using it in JVM arguments.
- If you add files, explain which are new and give exact commands to install dependencies, run in development, and build the Windows installer.

## Prompt to Claude
Please continue this project as a secure, working Minecraft Java Edition launcher. First inspect all files and summarize the existing UI and what is currently demo-only. Preserve the existing Obscura visual design (matte dark, restrained lime accent, no gradients) unless there is a concrete technical reason to change it. Build the Electron architecture with a secure preload/IPC boundary, then implement version metadata, Java checks, installation/launch, settings persistence, custom background persistence, and Microsoft authentication using maintained libraries and official flows. Do not claim features work until implemented and tested. Make changes in small steps, explain every file changed, and provide exact Windows commands to run and build. Do not store credentials or access tokens in renderer code or logs.
