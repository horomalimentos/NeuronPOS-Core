// Ventana de configuracion: direccion del restaurante e impresoras.
const $ = (id) => document.getElementById(id);
const api = window.setupApi;
let config;
let systemPrinters = [];

function show(el, text, ok) {
  el.textContent = text || '';
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

function readPrinter(section) {
  const f = (name) => section.querySelector(`[data-f="${name}"]`);
  return {
    type: f('type').value,
    name: f('name').value,
    host: f('host').value.trim(),
    port: Number(f('port').value) || 9100,
    paper: Number(f('paper').value) || 80,
    drawer: f('drawer').checked,
  };
}

function refreshVisibility(section) {
  const type = section.querySelector('[data-f="type"]').value;
  section.querySelectorAll('[data-show]').forEach((el) => {
    el.classList.toggle('hidden', !el.dataset.show.split(' ').includes(type));
  });
}

function mountPrinter(section) {
  const role = section.dataset.role;
  section.appendChild(document.getElementById('printerTpl').content.cloneNode(true));
  if (role !== 'ticket') section.querySelector('[data-drawer]').remove();
  const p = config.printers[role];
  const f = (name) => section.querySelector(`[data-f="${name}"]`);
  const names = f('name');
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'La predeterminada del sistema';
  names.appendChild(def);
  for (const sp of systemPrinters) {
    const o = document.createElement('option');
    o.value = sp.name;
    o.textContent = sp.displayName + (sp.isDefault ? ' (predeterminada)' : '');
    names.appendChild(o);
  }
  f('type').value = p.type;
  names.value = p.name;
  f('host').value = p.host;
  f('port').value = p.port;
  f('paper').value = String(p.paper);
  if (f('drawer')) f('drawer').checked = p.drawer;
  f('type').addEventListener('change', () => refreshVisibility(section));
  refreshVisibility(section);

  const msg = section.querySelector('[data-msg]');
  const btn = section.querySelector('[data-test]');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    show(msg, 'Imprimiendo…', true);
    const res = await api.test(role, readPrinter(section));
    show(msg, res.ok ? 'Listo. Revisa que haya salido la hoja de prueba.' : res.error, res.ok);
    btn.disabled = false;
  });
}

async function check() {
  const btn = $('check');
  btn.disabled = true;
  show($('urlMsg'), 'Verificando…', true);
  const res = await api.check($('url').value);
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
  const saved = await api.save(next);
  if (!saved.ok) { show($('saveMsg'), saved.error, false); btn.disabled = false; }
}

(async () => {
  const data = await api.get();
  config = data.config;
  document.title = `${data.appName} · Configuración`;
  $('title').textContent = data.appName;
  $('version').textContent = `Versión ${data.version}`;
  $('url').value = config.url.replace(/^https:\/\//, '');
  systemPrinters = await api.printers().catch(() => []);
  document.querySelectorAll('[data-role]').forEach(mountPrinter);
  if (data.mode === 'kds') {
    $('subtitle').textContent = 'Conecta esta pantalla de cocina con tu restaurante.';
    document.querySelector('[data-role="ticket"]').classList.add('hidden');
    document.querySelector('[data-role="comanda"] .hint').textContent = 'Se imprime una comanda cada vez que llegan artículos nuevos a esta pantalla (del punto de venta o pedidos en línea). Déjala en "Ninguna" si ya las imprime el punto de venta.';
  }
  $('check').addEventListener('click', check);
  $('save').addEventListener('click', save);
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
})();
