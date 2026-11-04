'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: 'Screen Recorder Pro',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- Auto-update (electron-updater + GitHub Releases) ------------------
// Updates are only checked in a packaged build. In dev (npm start) the
// feed has no release to check against, so checks are skipped gracefully.
// Flow: check on startup (and every 6h) -> notify renderer ->
// user clicks Download -> download -> user clicks Restart -> quitAndInstall.
// A new release must be published on GitHub (thisnaeem/screen-recorder-pro-releases)
// with a bumped version in package.json for an update to be found.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_e) { autoUpdater = null; }

function sendUpdateEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-event', payload);
}

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateEvent({ type: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateEvent({ type: 'available', version: info && info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateEvent({ type: 'not-available', version: app.getVersion() }));
  autoUpdater.on('download-progress', (p) => sendUpdateEvent({ type: 'progress', percent: Math.round(p && p.percent ? p.percent : 0) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateEvent({ type: 'downloaded', version: info && info.version }));
  autoUpdater.on('error', (err) => sendUpdateEvent({ type: 'error', message: err && err.message ? String(err.message).slice(0, 200) : 'Update check failed' }));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

ipcMain.handle('get-app-version', async () => app.getVersion());
ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev', version: app.getVersion() };
  const result = await autoUpdater.checkForUpdates().catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  return { status: 'checked', version: app.getVersion(), updateInfo: result && result.updateInfo ? result.updateInfo.version : null };
});
ipcMain.handle('download-update', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev' };
  await autoUpdater.downloadUpdate().catch(() => {});
  return { status: 'downloading' };
});
ipcMain.handle('install-update', async () => {
  if (!autoUpdater) return { status: 'unavailable' };
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { status: 'installing' };
});

app.whenReady().then(() => { createWindow(); setupAutoUpdate(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---- IPC: sources -------------------------------------------------------
ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 360, height: 202 },
    fetchWindowIcons: false
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL()
  }));
});

// Full-size screenshot of a screen/window via its desktopCapturer thumbnail.
ipcMain.handle('capture-screenshot', async (_event, sourceId) => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1920, height: 1080 }
  });
  const found = sources.find((s) => s.id === sourceId);
  if (!found) throw new Error('Source not found: ' + sourceId);
  return { name: found.name, dataUrl: found.thumbnail.toDataURL() };
});

// ---- IPC: files ----------------------------------------------------------
ipcMain.handle('show-save-dialog', async (_event, opts) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: opts && opts.defaultPath ? opts.defaultPath : undefined,
    filters: (opts && opts.filters) || [{ name: 'All Files', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('show-open-directory-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('save-data-url', async (_event, filePath, dataUrl) => {
  if (!filePath || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Invalid save request');
  }
  const base64 = dataUrl.split(',')[1];
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
});

ipcMain.handle('open-path', async (_event, filePath) => {
  await shell.openPath(filePath);
  return true;
});

ipcMain.handle('open-in-folder', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('get-file-url', async (_event, filePath) => {
  const { pathToFileURL } = require('url');
  return pathToFileURL(filePath).href;
});

ipcMain.handle('get-default-save-dir', async () => {
  const dir = path.join(app.getPath('videos'), 'Screen Recorder Pro');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* use as-is */ }
  return dir;
});
