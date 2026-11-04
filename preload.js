'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  captureScreenshot: (sourceId) => ipcRenderer.invoke('capture-screenshot', sourceId),
  showSaveDialog: (opts) => ipcRenderer.invoke('show-save-dialog', opts),
  showOpenDirectoryDialog: () => ipcRenderer.invoke('show-open-directory-dialog'),
  saveDataUrl: (filePath, dataUrl) => ipcRenderer.invoke('save-data-url', filePath, dataUrl),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  openInFolder: (filePath) => ipcRenderer.invoke('open-in-folder', filePath),
  getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  getDefaultSaveDir: () => ipcRenderer.invoke('get-default-save-dir'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateEvent: (cb) => ipcRenderer.on('update-event', (_e, payload) => cb(payload))
});
