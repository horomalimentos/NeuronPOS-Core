// App de escritorio de NeuronPOS (punto de venta) y Neuron KDS (cocina).
//
// Abre el sistema del restaurante (https://<restaurante>.neuronpos.app) en
// una ventana propia y le da lo que el navegador no puede: imprimir directo a
// las impresoras termicas (tickets, cortes y comandas) y abrir el cajon de
// dinero. Las dos apps salen del mismo codigo; "mode" (pos o kds) viene del
// package.json que arma electron-builder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, app, dialog, ipcMain, net, shell } from 'electron';
import updater from 'electron-updater';
import { createStore, normalizeUrl } from './config.js';
import { drawerCapable, openDrawer, printSystem, printWith, testPageHtml } from './printing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const MODE = process.env.NEURON_MODE || pkg.neuronMode || 'pos';
const IS_KDS = MODE === 'kds';
const APP_NAME = IS_KDS ? 'Neuron KDS' : 'NeuronPOS';
const START_PATH = IS_KDS ? '/admin/cocina' : '/admin/pos';

app.setName(APP_NAME);
// Solo para pruebas: carpeta de datos aparte.
if (process.env.NEURON_USER_DATA) app.setPath('userData', process.env.NEURON_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let store;
let mainWin = null;
let setupWin = null;

const allowedOrigin = () => store.get().url;

/** Solo las paginas del restaurante configurado pueden usar la impresora. */
function fromRestaurant(event) {
  const origin = allowedOrigin();
  try {
    return Boolean(origin) && new URL(event.senderFrame.url).origin === origin;
  } catch {
    return false;
  }
}
const fromSetup = (event) => Boolean(setupWin) && event.sender === setupWin.webContents;

function createMainWindow() {
  const { url } = store.get();
  mainWin = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#030712',
    fullscreen: IS_KDS,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Todo lo que no sea del restaurante se abre en el navegador normal.
  const sameOrigin = (target) => { try { return new URL(target).origin === url; } catch { return false; } };
  mainWin.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!sameOrigin(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, target) => {
    if (!sameOrigin(target)) { e.preventDefault(); shell.openExternal(target); }
  });
  mainWin.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navegacion cancelada
    mainWin.loadFile(path.join(here, 'offline.html'), { query: { url: failedUrl || url + START_PATH, error: desc } });
  });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.loadURL(url + START_PATH);
}

function openSetup() {
  if (setupWin) { setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 760,
    height: 820,
    title: `${APP_NAME} · Configuración`,
    parent: mainWin || undefined,
    modal: Boolean(mainWin),
    autoHideMenuBar: true,
    backgroundColor: '#030712',
    webPreferences: {
      preload: path.join(here, 'preload-setup.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  setupWin.on('closed', () => {
    setupWin = null;
    if (!mainWin && store.get().url) createMainWindow();
    if (!mainWin && !store.get().url) app.quit();
  });
  setupWin.loadFile(path.join(here, 'setup.html'));
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { label: 'Configuración e impresoras…', accelerator: 'CmdOrCtrl+,', click: openSetup },
        { type: 'separator' },
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => mainWin?.webContents.reload() },
        { label: 'Ir al inicio', click: () => mainWin?.loadURL(store.get().url + START_PATH) },
        { label: 'Pantalla completa', accelerator: 'F11', click: () => mainWin?.setFullScreen(!mainWin.isFullScreen()) },
        { label: 'Herramientas de desarrollo', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWin?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: `Versión ${app.getVersion()}`, enabled: false },
        { role: 'quit', label: 'Salir' },
      ],
    },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
}

// ---------------------------------------------------------------------------
// API para el sistema del restaurante (window.neuronNative)
// ---------------------------------------------------------------------------

ipcMain.handle('native:info', (event) => {
  if (!fromRestaurant(event)) return null;
  const { printers } = store.get();
  return {
    platform: 'desktop',
    mode: MODE,
    version: app.getVersion(),
    printers: { ticket: printers.ticket.type !== 'none', comanda: printers.comanda.type !== 'none' },
    drawer: drawerCapable(printers.ticket),
  };
});

ipcMain.handle('native:print', async (event, job) => {
  if (!fromRestaurant(event)) throw new Error('No autorizado');
  const html = String(job?.html || '');
  if (!html || html.length > 2_000_000) throw new Error('Documento inválido');
  const role = job?.role === 'comanda' ? 'comanda' : job?.role === 'documento' ? 'documento' : 'ticket';
  if (role === 'documento') {
    await printSystem(html, { dialog: true });
    return { printed: true };
  }
  return printWith(store.get().printers[role], html, { openDrawer: Boolean(job?.openDrawer) });
});

ipcMain.handle('native:drawer', async (event) => {
  if (!fromRestaurant(event)) throw new Error('No autorizado');
  return openDrawer(store.get().printers.ticket);
});

ipcMain.handle('native:settings', (event) => {
  if (!fromRestaurant(event)) return false;
  openSetup();
  return true;
});

// ---------------------------------------------------------------------------
// API de la ventana de configuracion (window.setupApi)
// ---------------------------------------------------------------------------

ipcMain.handle('setup:get', (event) => {
  if (!fromSetup(event)) return null;
  return { config: store.get(), mode: MODE, appName: APP_NAME, version: app.getVersion() };
});

ipcMain.handle('setup:printers', async (event) => {
  if (!fromSetup(event)) return [];
  const list = await setupWin.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: Boolean(p.isDefault) }));
});

ipcMain.handle('setup:check', async (event, input) => {
  if (!fromSetup(event)) return null;
  const origin = normalizeUrl(input);
  if (!origin) return { ok: false, error: 'Escribe la dirección de tu restaurante, por ejemplo tacos.neuronpos.app' };
  try {
    const res = await net.fetch(`${origin}/api/public/site`, { signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return { ok: false, error: `No encontramos un restaurante en ${origin}` };
    if (!res.ok) return { ok: false, error: `El servidor respondió ${res.status}` };
    const data = await res.json();
    return { ok: true, origin, name: data?.restaurant?.name || origin };
  } catch {
    return { ok: false, error: `No se pudo conectar con ${origin}. Revisa la dirección y tu internet.` };
  }
});

ipcMain.handle('setup:test', async (event, role, printer) => {
  if (!fromSetup(event)) return null;
  try {
    const res = await printWith(printer, testPageHtml(role, printer));
    return res.printed ? { ok: true } : { ok: false, error: 'Elige una impresora' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('setup:save', (event, next) => {
  if (!fromSetup(event)) return null;
  const before = store.get().url;
  const saved = store.set(next);
  if (!saved.url) return { ok: false, error: 'Falta la dirección del restaurante' };
  if (mainWin && before !== saved.url) mainWin.loadURL(saved.url + START_PATH);
  setupWin?.close();
  return { ok: true };
});

// ---------------------------------------------------------------------------

async function checkUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Reiniciar ahora', 'Después'],
      defaultId: 0,
      title: 'Actualización lista',
      message: `Hay una nueva versión de ${APP_NAME} (${info.version}).`,
      detail: 'Se instala al reiniciar la app.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', () => { /* sin internet o sin servidor: se intenta la proxima vez */ });
  autoUpdater.checkForUpdates().catch(() => {});
}

app.on('second-instance', () => {
  const w = mainWin || setupWin;
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));
  if (process.env.NEURON_URL) store.set({ ...store.get(), url: process.env.NEURON_URL });
  buildMenu();
  if (store.get().url) createMainWindow();
  else openSetup();
  checkUpdates();
});

app.on('window-all-closed', () => app.quit());
