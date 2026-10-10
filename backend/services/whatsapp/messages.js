// Mensajes de WhatsApp (texto, botones, listas, ligas y pedir ubicacion),
// con los limites de la Cloud API recortados aqui para que Meta no los
// rechace: botones de 20 caracteres (maximo 3), filas de lista de 24 con
// descripcion de 72 (maximo 10), cuerpo de 1024 en interactivos.

const cut = (s, n) => {
  const v = String(s ?? '').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

export const text = (body) => ({ type: 'text', text: { body: cut(body, 4096), preview_url: true } });

/** buttons: [{ id, title }] (maximo 3). */
export const buttons = (body, list) => ({
  type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: cut(body, 1024) },
    action: { buttons: list.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: cut(b.title, 20) } })) },
  },
});

/** rows: [{ id, title, description? }] (maximo 10, en una seccion). */
export const list = (body, button, rows, { header = null, sectionTitle = 'Opciones' } = {}) => ({
  type: 'interactive',
  interactive: {
    type: 'list',
    ...(header ? { header: { type: 'text', text: cut(header, 60) } } : {}),
    body: { text: cut(body, 1024) },
    action: {
      button: cut(button, 20),
      sections: [{
        title: cut(sectionTitle, 24),
        rows: rows.slice(0, 10).map((r) => ({
          id: String(r.id).slice(0, 200),
          title: cut(r.title, 24),
          ...(r.description ? { description: cut(r.description, 72) } : {}),
        })),
      }],
    },
  },
});

export const link = (body, label, url) => ({
  type: 'interactive',
  interactive: {
    type: 'cta_url',
    body: { text: cut(body, 1024) },
    action: { name: 'cta_url', parameters: { display_text: cut(label, 20), url } },
  },
});

export const askLocation = (body) => ({
  type: 'interactive',
  interactive: { type: 'location_request_message', body: { text: cut(body, 1024) }, action: { name: 'send_location' } },
});

export const money = (n) => `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
