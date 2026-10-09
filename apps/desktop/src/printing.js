// Impresion directa desde la app de escritorio.
//
//  - "system":  impresora instalada en el sistema (driver de Windows, CUPS),
//               sin ventana de impresion.
//  - "network": impresora termica por red (IP, puerto 9100). El HTML del
//               ticket se dibuja en una ventana oculta, se captura como
//               imagen y se manda como mapa de bits ESC/POS. Asi sale igual
//               que en pantalla (acentos, logo) sin depender del driver.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { BrowserWindow, webContents } from 'electron';
import { PAPER_DOTS, drawerPulse, rasterJob, toMonochrome, trimBottom } from './escpos.js';

const toDataUrl = (html) => `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;

// Espera a que carguen las imagenes (logo) y las fuentes.
const WAIT_ASSETS = `Promise.all([
  document.fonts ? document.fonts.ready : null,
  ...Array.from(document.images).map((img) => img.complete ? null
    : new Promise((r) => { img.onload = r; img.onerror = r; setTimeout(r, 4000); })),
]).then(() => true)`;

async function loadHidden(html, extra = {}) {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 600,
    ...extra,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: true, ...(extra.webPreferences || {}) },
  });
  await win.loadURL(toDataUrl(html));
  await win.webContents.executeJavaScript(WAIT_ASSETS, true);
  return win;
}

/** Impresora del sistema; `dialog` muestra la ventana de impresion normal. */
export async function printSystem(html, { name = '', copies = 1, dialog = false } = {}) {
  const win = await loadHidden(html);
  try {
    await new Promise((resolve, reject) => {
      win.webContents.print(
        { silent: !dialog, deviceName: dialog ? undefined : name || undefined, printBackground: true, copies, margins: { marginType: 'none' } },
        (ok, reason) => (ok || reason === 'cancelled' ? resolve() : reject(new Error(reason || 'No se pudo imprimir'))),
      );
    });
  } finally {
    win.destroy();
  }
}

/** Dibuja el HTML al ancho del papel y regresa la imagen en 1 bit. */
export async function renderRaster(html, paper = 80) {
  const dots = PAPER_DOTS[paper] || PAPER_DOTS[80];
  const zoom = 2; // 1 px CSS = 2 puntos (203 dpi ~ 2.13 puntos/px)
  const cssWidth = Math.floor(dots / zoom);
  const win = await loadHidden(html, {
    width: dots,
    height: 800,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  try {
    win.webContents.setZoomFactor(zoom);
    await win.webContents.insertCSS(`
      @page { margin: 0 }
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
      body { width: ${cssWidth - 8}px !important; padding: 0 4px !important; }
    `);
    const cssHeight = await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => r(Math.ceil(document.documentElement.scrollHeight))))',
      true,
    );
    const height = Math.min(Math.ceil(cssHeight * zoom) + 8, 20000);
    win.setContentSize(dots, height);
    await new Promise((r) => setTimeout(r, 150));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: dots, height });
    const size = image.getSize();
    const mono = toMonochrome(image.toBitmap(), size.width, size.height, { order: 'bgra' });
    return { mono, height: trimBottom(mono, size.height), width: size.width };
  } finally {
    win.destroy();
  }
}

export function sendTcp(host, port, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeoutMs, () => fail(new Error(`La impresora ${host}:${port} no respondió`)));
    socket.on('error', (err) => fail(new Error(`No se pudo conectar con la impresora ${host}:${port} (${err.code || err.message})`)));
    socket.on('connect', () => socket.end(data, () => resolve()));
  });
}

export async function printNetwork(html, { host, port = 9100, paper = 80, openDrawer = false, cut = true } = {}) {
  if (!host) throw new Error('Falta la dirección IP de la impresora');
  const { mono, height } = await renderRaster(html, paper);
  await sendTcp(host, port, rasterJob(mono, height, { cut, openDrawer }));
}

// Manda bytes tal cual (RAW) a una impresora instalada en Windows, por
// ejemplo el pulso del cajon a una termica USB. Usa la API de impresion de
// Windows (winspool) desde PowerShell; no requiere modulos nativos.
const RAW_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NeuronRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static void Send(string name, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(name, out h, IntPtr.Zero)) throw new Exception("No se encontro la impresora " + name);
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "NeuronPOS"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("La impresora no acepto el trabajo");
      StartPagePrinter(h);
      int w; WritePrinter(h, data, data.Length, out w);
      EndPagePrinter(h); EndDocPrinter(h);
    } finally { ClosePrinter(h); }
  }
}
'@
[NeuronRaw]::Send($env:NEURON_PRINTER, [Convert]::FromBase64String($env:NEURON_RAW))
`;

/** Termica USB instalada en Windows: el mismo ESC/POS que por red, en RAW. */
export async function printUsb(html, { name = '', paper = 80, openDrawer = false, cut = true } = {}) {
  if (process.platform !== 'win32') throw new Error('La impresión USB directa solo funciona en Windows; usa "Con el driver"');
  const { mono, height } = await renderRaster(html, paper);
  await sendWindowsRaw(name, rasterJob(mono, height, { cut, openDrawer }));
}

async function defaultPrinterName() {
  const wc = webContents.getAllWebContents()[0];
  const list = wc ? await wc.getPrintersAsync() : [];
  return list.find((p) => p.isDefault)?.name || '';
}

export async function sendWindowsRaw(name, data) {
  if (process.platform !== 'win32') throw new Error('La impresión USB directa solo funciona en Windows');
  const printer = name || await defaultPrinterName();
  if (!printer) throw new Error('No hay impresora predeterminada');
  await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RAW_PS], {
      windowsHide: true,
      env: { ...process.env, NEURON_PRINTER: printer, NEURON_RAW: Buffer.from(data).toString('base64') },
    });
    let err = '';
    ps.stderr.on('data', (d) => { err += d; });
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'No se pudo abrir el cajón'))));
  });
}

/** El cajon se puede abrir con esta impresora (red, o USB en Windows). */
export const drawerCapable = (printer) => Boolean(printer?.drawer)
  && (printer.type === 'network' || (['system', 'usb'].includes(printer.type) && process.platform === 'win32'));

/** Imprime con la impresora configurada para el rol (ticket o comanda). */
export async function printWith(printer, html, { openDrawer: drawer = false } = {}) {
  if (!printer || printer.type === 'none') return { printed: false };
  if (printer.type === 'network') {
    await printNetwork(html, { host: printer.host, port: printer.port, paper: printer.paper, openDrawer: drawer && printer.drawer });
  } else if (printer.type === 'usb') {
    await printUsb(html, { name: printer.name, paper: printer.paper, openDrawer: drawer && printer.drawer });
  } else {
    await printSystem(html, { name: printer.name });
    if (drawer && drawerCapable(printer)) await sendWindowsRaw(printer.name, drawerPulse());
  }
  return { printed: true };
}

export async function openDrawer(printer) {
  if (!drawerCapable(printer)) return false;
  if (printer.type === 'network') await sendTcp(printer.host, printer.port, drawerPulse());
  else await sendWindowsRaw(printer.name, drawerPulse());
  return true;
}

export function testPageHtml(role, printer) {
  const now = new Date().toLocaleString('es-MX');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: ui-monospace, 'Courier New', monospace; font-size: 12px; width: 72mm; margin: 0; }
    h1 { font-size: 18px; text-align: center; margin: 6px 0; }
    .c { text-align: center; } hr { border: 0; border-top: 1px dashed #000; }
  </style></head><body>
    <h1>NeuronPOS</h1>
    <div class="c">Prueba de impresora</div><hr>
    <div>Uso: <b>${role === 'comanda' ? 'Comandas de cocina' : 'Tickets y cortes'}</b></div>
    <div>Tipo: ${printer.type === 'network' ? `Red ${printer.host}:${printer.port}` : `${printer.type === 'usb' ? 'USB directa' : 'Driver'} ${printer.name || '(predeterminada)'}`}</div>
    <div>Papel: ${printer.paper} mm</div>
    <div>Acentos: áéíóú ñ Ñ ¿? ¡!</div><hr>
    <div class="c">${now}</div>
  </body></html>`;
}
