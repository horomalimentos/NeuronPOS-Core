// Puente entre el sistema del restaurante (pagina web) y la app de escritorio.
// El proceso principal vuelve a validar que la pagina sea del restaurante
// configurado antes de imprimir.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neuronNative', {
  info: () => ipcRenderer.invoke('native:info'),
  print: (job) => ipcRenderer.invoke('native:print', job),
  openDrawer: () => ipcRenderer.invoke('native:drawer'),
  openSettings: () => ipcRenderer.invoke('native:settings'),
});
