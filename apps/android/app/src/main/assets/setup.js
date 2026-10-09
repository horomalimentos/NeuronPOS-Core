// Configuracion de la app de Android: direccion del restaurante e impresoras.
// Usa window.NeuronSetup (MainActivity.SetupBridge). Las llamadas largas
// responden por window.__neuronCb(id, resultado).
const $ = (id) => document.getElementById(id);
const bridge = window.NeuronSetup;
const pending = new Map();
let seq = 0;
window.__neuronCb = (id, result) => {
  const fn = pending.get(id);
  pending.delete(id);
  if (fn) fn(result);
};
const call = (fn) => new Promise((resolve) => {
  const id = `cb${++seq}`;
  pending.set(id, resolve);
  fn(id);
});

let config;
let devices = [];
let usbDevices = [];

function show(el, text, ok) {
  el.textContent = text || '';
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

const field = (section, name) => section.querySelector(`[data-f="${name}"]`);

function readPrinter(section) {
  const addr = field(section, 'address');
  const opt = addr.selectedOptions[0];
  const usb = field(section, 'usb');
  const type = field(section, 'type').value;
  return {
    type,
    host: field(section, 'host').value.trim(),
    port: Number(field(section, 'port').value) || 9100,
    address: addr.value,
    usb: usb.value,
    name: type === 'usb' ? usb.selectedOptions[0]?.dataset.name || '' : opt ? opt.dataset.name || '' : '',
    paper: Number(field(section, 'paper').value) || 80,
    drawer: Boolean(field(section, 'drawer')?.checked),
  };
}

function refreshVisibility(section) {
  const type = field(section, 'type').value;
  section.querySelectorAll('[data-show]').forEach((el) => {
    el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(type));
  });
}

function fillDevices(section, selected) {
  const sel = field(section, 'address');
  sel.innerHTML = '';
  const list = devices.slice();
  if (selected && !list.some((d) => d.address === selected.address)) list.unshift(selected);
  if (!list.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Toca "Buscar" para ver tus impresoras vinculadas';
    sel.appendChild(o);
  }
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.address;
    o.dataset.name = d.name;
    o.textContent = `${d.name} (${d.address})`;
    sel.appendChild(o);
  }
  if (selected?.address) sel.value = selected.address;
}

function fillUsb(section, selected) {
  const sel = field(section, 'usb');
  sel.innerHTML = '';
  const list = usbDevices.slice();
  if (selected?.id && !list.some((d) => d.id === selected.id)) list.unshift(selected);
  if (!list.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Conecta la impresora y toca "Buscar"';
    sel.appendChild(o);
  }
  for (const d of list) {
    const o = document.createElement('option');
    o.value = d.id;
    o.dataset.name = d.name;
    o.textContent = d.name;
    sel.appendChild(o);
  }
  if (selected?.id) sel.value = selected.id;
}

async function loadUsb(section) {
  usbDevices = JSON.parse(bridge.usbDevices() || '[]');
  document.querySelectorAll('[data-role]').forEach((s) => fillUsb(s, { id: field(s, 'usb').value, name: field(s, 'usb').selectedOptions[0]?.dataset.name }));
  if (!usbDevices.length) return 'No encontré impresoras USB. Revisa el cable OTG y que esté encendida.';
  const id = field(section, 'usb').value || usbDevices[0].id;
  field(section, 'usb').value = id;
  const perm = await call((cb) => bridge.requestUsb(id, cb));
  return perm.error || '';
}

async function loadDevices() {
  const perm = await call((id) => bridge.requestBluetooth(id));
  if (perm.error) return perm.error;
  devices = JSON.parse(bridge.bluetoothDevices() || '[]');
  document.querySelectorAll('[data-role]').forEach((s) => fillDevices(s, readPrinter(s)));
  return devices.length ? '' : 'No hay impresoras vinculadas. Vincúlala en Ajustes > Bluetooth y vuelve a buscar.';
}

function mountPrinter(section) {
  const role = section.dataset.role;
  section.appendChild(document.getElementById('printerTpl').content.cloneNode(true));
  if (role !== 'ticket') section.querySelector('[data-drawer]').remove();
  const p = config.printers[role];
  field(section, 'type').value = ['bluetooth', 'network', 'usb'].includes(p.type) ? p.type : 'none';
  field(section, 'host').value = p.host;
  field(section, 'port').value = p.port;
  field(section, 'paper').value = String(p.paper);
  if (field(section, 'drawer')) field(section, 'drawer').checked = p.drawer;
  fillDevices(section, p.address ? { address: p.address, name: p.name || p.address } : null);
  fillUsb(section, p.usb ? { id: p.usb, name: p.name || `Impresora USB ${p.usb}` } : null);
  field(section, 'type').addEventListener('change', () => refreshVisibility(section));
  refreshVisibility(section);

  const msg = section.querySelector('[data-msg]');
  section.querySelector('[data-bt]').addEventListener('click', async () => {
    show(msg, 'Buscando…', true);
    const err = await loadDevices();
    show(msg, err || 'Elige tu impresora de la lista.', !err);
  });
  section.querySelector('[data-usb]').addEventListener('click', async () => {
    show(msg, 'Buscando…', true);
    const err = await loadUsb(section);
    show(msg, err || 'Impresora USB lista.', !err);
  });
  const btn = section.querySelector('[data-test]');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    show(msg, 'Imprimiendo…', true);
    const res = await call((id) => bridge.test(role, JSON.stringify(readPrinter(section)), id));
    show(msg, res.ok ? 'Listo. Revisa que haya salido la hoja de prueba.' : res.error, res.ok);
    btn.disabled = false;
  });
}

async function check() {
  const btn = $('check');
  btn.disabled = true;
  show($('urlMsg'), 'Verificando…', true);
  const res = await call((id) => bridge.check($('url').value, id));
  btn.disabled = false;
  if (res.ok) {
    $('url').value = res.origin.replace(/^https:\/\//, '');
    show($('urlMsg'), `Conectado con ${res.name}`, true);
  } else {
    show($('urlMsg'), res.error, false);
  }
  return res;
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  const res = await check();
  if (!res.ok) { btn.disabled = false; return; }
  const next = {
    url: res.origin,
    printers: {
      ticket: readPrinter(document.querySelector('[data-role="ticket"]')),
      comanda: readPrinter(document.querySelector('[data-role="comanda"]')),
    },
  };
  const saved = JSON.parse(bridge.save(JSON.stringify(next)));
  if (!saved.ok) { show($('saveMsg'), saved.error, false); btn.disabled = false; }
}

(() => {
  const data = JSON.parse(bridge.get());
  config = data.config;
  $('title').textContent = data.appName;
  $('version').textContent = `Versión ${data.version}`;
  $('url').value = config.url.replace(/^https:\/\//, '');
  document.querySelectorAll('[data-role]').forEach(mountPrinter);
  if (data.mode === 'kds') {
    $('subtitle').textContent = 'Conecta esta pantalla de cocina con tu restaurante.';
    document.querySelector('[data-role="ticket"]').classList.add('hidden');
    document.querySelector('[data-role="comanda"] .hint').textContent = 'Se imprime una comanda cada vez que llegan artículos nuevos a esta pantalla (del punto de venta o pedidos en línea). Déjala en "Ninguna" si ya las imprime el punto de venta.';
  }
  if (config.url) {
    $('cancel').classList.remove('hidden');
    $('cancel').addEventListener('click', () => bridge.cancel());
  }
  $('check').addEventListener('click', check);
  $('save').addEventListener('click', save);
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
})();
