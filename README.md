# Screen Recorder Pro

A professional, local-only desktop app for screen recording and screenshots, with a post-recording editor (auto zoom, trim, annotations, captions, cursor highlight, click ripple) and WebM/MP4 export. Built with Electron. No paid APIs, no accounts, no external services — everything runs on your machine.

## Features

- **Screen recording** — pick a screen, window, or (via the OS picker on some setups) an area; start / pause / resume / stop; 3-second countdown (adjustable); microphone toggle; webcam overlay toggle (baked into the recording via a canvas compositor); system-audio toggle where supported.
- **Screenshots** — capture a full screen or window as PNG, then edit: crop, rectangle, arrow, text, highlight, blur/pixelate. Save as PNG (JPG via the canvas export path in the editor — see note below).
- **Auto zoom** — in the editor, “Auto zoom (follow action)” generates smooth, eased zoom keyframes that zoom in on focus areas and zoom out between them. Adjustable zoom level and transition speed. Manual keyframes: click the preview to set a focus point, then “+ Keyframe here”.
- **Editor** — trim (start/end), timeline scrub with keyframe markers, playback speed (0.5×–2×), cursor highlight, click ripple on click keyframes, text overlays, captions, blurred background option.
- **Export** — edited video as WebM (recommended) or MP4 where the Chromium codec supports it; raw recording save; screenshots as PNG/JPG; project settings as JSON. Export shows progress and the final file path.
- **Library** — recent recordings/screenshots with thumbnails; click a video to reload it in the editor, click a screenshot to edit it, right-click to reveal in folder.
- **UI** — dark modern layout: source picker (left), preview (centre), editor (right), timeline (bottom). Settings page for save folder, zoom defaults, mic/webcam defaults.
- **Shortcuts** — Ctrl/Cmd+Shift+R record/stop, Ctrl/Cmd+Shift+P pause/resume, Ctrl/Cmd+Shift+S screenshot, Space play/pause the editor video.

## Install & run

Requirements: Node.js 18+ and npm.

```bash
cd screen-recorder-pro
npm install
npm start
```

## Build installers (optional)

```bash
npm run build        # current OS
npm run build:win    # Windows NSIS installer (run on Windows, or with wine tooling)
npm run build:mac    # macOS DMG (run on macOS)
npm run build:linux  # Linux AppImage
npm run pack         # unpacked directory build, no installer
```

Installers land in `dist/`.

## Permissions (important)

- **macOS:** grant Screen Recording (and Microphone/Camera if used) in System Settings → Privacy & Security. Without it, the source list will be empty.
- **Windows:** screen capture works out of the box; system audio capture from a desktop source works on Windows in most Chromium builds.
- **Linux:** screen capture depends on the compositor (X11 works best; Wayland portal support varies by distro/Electron version).

## Known limitations (honest notes)

- **System audio:** Electron/Chromium desktop capture exposes system audio reliably on Windows; on macOS it is generally *not* available without a third-party virtual audio driver, and on Linux it varies. If it fails, the app warns and records without system audio — microphone audio still works.
- **MP4 export:** `MediaRecorder` MP4 (`video/mp4;codecs=avc1`) support depends on the Chromium build bundled with Electron. If it is unsupported, the app automatically falls back to WebM and says so in the export status. WebM is the reliable path; convert WebM → MP4 afterwards with ffmpeg if you need it: `ffmpeg -i edited.webm -c:v libx264 -c:a aac edited.mp4`.
- **Auto zoom “following the action”:** the app cannot read the OS mouse cursor from a captured video stream, so auto zoom generates smooth keyframes across sensible focus areas (centre / corners) rather than tracking a real cursor. For exact focus, click the preview to set a focus point and add manual keyframes — those *do* follow the spot you chose.
- **Screenshot JPG:** the screenshot editor has both “Save screenshot…” (PNG) and “Save as JPG…” buttons.
- **Area (region) recording:** Electron's `desktopCapturer` lists whole screens/windows, not arbitrary regions. To record a region, record the full screen and trim/crop in the editor, or use the OS region picker where your platform offers one.
- **No GUI in a headless sandbox:** `npm start` needs a display. The code is syntax-checked and file-checked in CI/sandbox, but the window itself can only be launched on a real desktop.

## Project layout

```
main.js            Electron main process (window, desktopCapturer, dialogs, file saves)
preload.js         contextBridge — the only bridge the renderer may use
src/index.html     UI layout
src/styles.css     Dark theme
src/renderer.js    Recording, screenshots, editor, zoom, export, library, settings
package.json       Scripts: start / pack / build (+ per-OS builds)
```

## Privacy

Recordings and screenshots are saved only where *you* choose. Nothing is uploaded anywhere.

## Auto-update

The app checks for updates on startup and every 6 hours (Settings → Updates can turn the startup check off, or check manually). Updates are delivered from GitHub Releases via `electron-updater`:

1. Bump `version` in `package.json`.
2. Push the code to GitHub (`thisnaeem/screen-recorder-pro-releases`).
3. Build and publish a release: `npm run build -- --publish always` (or upload the `dist/` artifacts to a GitHub Release manually).
4. Users on a packaged build get a banner: Download → Restart & install. The update installs on restart; no data or settings are touched.

Notes: auto-update only works in a packaged build, not under `npm start`. On macOS, published builds should be signed/notarized for silent updates; unsigned builds may require the user to re-install manually.
