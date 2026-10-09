// API de la ventana de configuracion (pagina local de la app).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupApi', {
  get: () => ipcRenderer.invoke('setup:get'),
  printers: () => ipcRenderer.invoke('setup:printers'),
  check: (url) => ipcRenderer.invoke('setup:check', url),
  test: (role, printer) => ipcRenderer.invoke('setup:test', role, printer),
  save: (config) => ipcRenderer.invoke('setup:save', config),
});
