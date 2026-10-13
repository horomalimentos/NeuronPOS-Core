// Ventana de "Nuevo pedido" (pagina local): solo puede pedir abrir el pedido.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nayoAlert', {
  open: () => ipcRenderer.invoke('alert:open'),
});
