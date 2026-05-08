const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electron', {
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_, data) => cb(data)),
});
