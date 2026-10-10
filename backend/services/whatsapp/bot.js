// Conversacion del bot de WhatsApp, adaptada de whatsappBot.js de Horom
// para varios restaurantes: menu principal, pedido en el chat (sucursal,
// recoger o domicilio, categorias, productos, modificadores, cantidad,
// carrito, ubicacion, direccion, nombre, pago y confirmacion), estado del
// pedido, horarios, preguntas frecuentes y paso a una persona.
//
// runBot no manda nada: regresa los mensajes a mandar y el nuevo estado de
// la conversacion. El pedido se crea con createOnlineOrder, igual que el
// sitio del restaurante (mismas validaciones y precios del servidor).
import { loadMenu } from '../../routes/pos/menu.js';
import { HttpError } from '../../utils/http.js';
import { loadZones, quoteZone } from '../deliveryZones.js';
import { hhmm } from '../hours.js';
import { CUSTOMER_STATUS_LABEL, customerStatus, getOnlineSettings, loadBranches } from '../online.js';
import { createOnlineOrder, prepareOrder, readOrderInput } from '../onlineOrders.js';
import { getPaymentSettings, onlinePaymentAvailable } from '../restaurantPayments.js';
import { restaurantSiteUrl } from '../urls.js';
import * as M from './messages.js';

const DAY = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const PAGE = 8;
// Sin escribir en este tiempo, la conversacion vuelve a empezar (el carrito se conserva).
const IDLE_MS = 6 * 60 * 60 * 1000;

export const normalize = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¡!¿?.,;:]/g, ' ').replace(/\s+/g, ' ').trim();

const GREETING = /^(hola|holi|buen[oa]s?( dias| tardes| noches)?|menu|inicio|empezar|hi|hello|que tal)\b/;
const HUMAN = /\b(asesor|humano|persona|agente|alguien|operador|encargad[oa])\b/;

const lineTotal = (l) => l.unit_price * l.quantity;
const cartSubtotal = (cart) => cart.reduce((s, l) => s + lineTotal(l), 0);
const cartLines = (cart) => cart.map((l) => `${l.quantity} × ${l.name}${l.modifier_names.length ? ` (${l.modifier_names.join(', ')})` : ''} — ${M.money(lineTotal(l))}`).join('\n');

class Bot {
  constructor(db, { tenant, settings, conversation, mods, now }) {
    this.db = db;
    this.tenant = tenant;
    this.rid = tenant.id;
    this.settings = settings;
    this.conv = conversation;
    this.mods = mods;
    this.now = now;
    this.ctx = structuredClone(conversation.context || {});
    this.state = conversation.state || 'inicio';
    this.mode = conversation.mode;
    this.needsAttention = conversation.needs_attention;
    this.replies = [];
  }

  // --- utilidades ---

  send(message, options = null) {
    this.replies.push(message);
    if (options) this.ctx.options = options;
  }

  ask(state, message, options) {
    this.state = state;
    this.send(message, options);
  }

  get cart() {
    if (!Array.isArray(this.ctx.cart)) this.ctx.cart = [];
    return this.ctx.cart;
  }

  get siteUrl() {
    return restaurantSiteUrl(this.tenant);
  }

  async branches() {
    if (!this._branches) this._branches = await loadBranches(this.db, this.rid, { now: this.now });
    return this._branches;
  }

  async branch() {
    return (await this.branches()).find((b) => b.id === this.ctx.branch_id) || null;
  }

  async onlineSettings() {
    if (!this._online) this._online = await getOnlineSettings(this.db, this.rid);
    return this._online;
  }

  async menu() {
    if (!this._menu) {
      const m = await loadMenu(this.db, this.rid, { branchId: this.ctx.branch_id });
      const cats = new Set(m.categories.map((c) => c.id));
      const items = m.items.filter((i) => i.available && cats.has(i.category_id));
      const groups = new Map(m.modifier_groups.map((g) => [g.id, g]));
      this._menu = { categories: m.categories.filter((c) => items.some((i) => i.category_id === c.id)), items, groups };
    }
    return this._menu;
  }

  async orderingAvailable() {
    return Boolean(this.mods.ordering && (await this.onlineSettings()).enabled);
  }

  async zone() {
    if (!this.mods.zonas || this.ctx.order_type !== 'domicilio') return null;
    return (await loadZones(this.db, this.rid)).get(this.ctx.branch_id) || null;
  }

  /** Lo que el cliente escribio o toco, como id de opcion si corresponde. */
  optionFor(input) {
    if (input.id) return input.id;
    const options = this.ctx.options || [];
    const t = normalize(input.text);
    if (!t) return null;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].id;
    const exact = options.find((o) => normalize(o.title) === t);
    if (exact) return exact.id;
    if (t.length >= 3) {
      const starts = options.filter((o) => normalize(o.title).startsWith(t));
      if (starts.length === 1) return starts[0].id;
    }
    return null;
  }

  // --- menu principal ---

  async mainMenu(intro = null) {
    const name = this.conv.profile_name ? ` ${this.conv.profile_name.split(' ')[0]}` : '';
    const body = intro || this.settings.welcome_text?.trim()
      || `¡Hola${name}! Soy el asistente de ${this.tenant.name}. ¿En qué te ayudo?`;
    const rows = [];
    if (this.cart.length) rows.push({ id: 'seguir', title: 'Seguir con mi pedido', description: `${this.cart.length} producto(s) · ${M.money(cartSubtotal(this.cart))}` });
    if (await this.orderingAvailable()) rows.push({ id: 'pedir', title: 'Hacer un pedido', description: 'Ver el menú y pedir por aquí' });
    rows.push({ id: 'estado', title: 'Mi pedido', description: '¿Cómo va mi pedido?' });
    rows.push({ id: 'horario', title: 'Horario y sucursales' });
    (this.settings.faqs || []).slice(0, 5).forEach((f, i) => rows.push({ id: `faq:${i}`, title: f.question }));
    rows.push({ id: 'humano', title: 'Hablar con una persona' });
    this.ask('inicio', M.list(body, 'Ver opciones', rows), rows);
  }

  async handoff() {
    this.mode = 'humano';
    this.needsAttention = true;
    this.state = 'inicio';
    this.send(M.text('Listo, ya avisé al equipo. En un momento te responde una persona por aquí; puedes escribir tu duda mientras.'));
  }

  async hours() {
    const list = (await this.branches());
    if (!list.length) {
      this.send(M.text('Por ahora no tenemos sucursales publicadas.'));
    } else {
      const blocks = list.map((b) => {
        const h = b.hours.length ? b.hours.map((x) => `${DAY[x.weekday]} ${hhmm(x.opens_at)}–${hhmm(x.closes_at)}`).join('\n') : 'Sin horario publicado';
        return [`*${b.name}* (${b.status.open ? 'abierto ahora' : 'cerrado ahora'})`, b.address, b.phone ? `Tel. ${b.phone}` : null, h, b.maps_url]
          .filter(Boolean).join('\n');
      });
      this.send(M.text(blocks.join('\n\n')));
    }
    this.backToMenu();
  }

  backToMenu(body = '¿Algo más?') {
    const opts = [{ id: 'menu', title: 'Menú principal' }];
    if (this.cart.length) opts.unshift({ id: 'seguir', title: 'Seguir mi pedido' });
    this.ask('inicio', M.buttons(body, opts), opts);
  }

  async orderStatus() {
    const orders = (await this.db.query(
      `SELECT id, folio, status, online_status, online_payment_status, order_type, scheduled_for, sent_at,
              dispatched_at, total, public_token
         FROM orders
        WHERE restaurant_id = $1 AND source = 'web' AND created_at > now() - interval '3 days'
          AND right(regexp_replace(coalesce(customer_phone, ''), '\\D', '', 'g'), 10) = right($2, 10)
        ORDER BY created_at DESC LIMIT 3`,
      [this.rid, this.conv.wa_id],
    )).rows;
    if (!orders.length) {
      this.send(M.text('No encontré pedidos recientes con este número.'));
    } else {
      this.send(M.text(orders.map((o) => `*Pedido #${o.folio}* · ${CUSTOMER_STATUS_LABEL[customerStatus(o)]} · ${M.money(o.total)}\n${this.siteUrl}/pedido/${o.public_token}`).join('\n\n')));
    }
    this.backToMenu();
  }

  // --- pedido ---

  async startOrder() {
    if (!(await this.orderingAvailable())) {
      this.send(M.text('Por ahora no estamos tomando pedidos por aquí.'));
      return this.backToMenu();
    }
    const list = (await this.branches()).filter((b) => b.online_enabled);
    if (!list.length) {
      this.send(M.text('Por ahora ninguna sucursal está recibiendo pedidos.'));
      return this.backToMenu();
    }
    if (list.length === 1) return this.selectBranch(list[0]);
    const rows = list.slice(0, 10).map((b) => ({ id: `b:${b.id}`, title: b.name, description: b.status.open ? 'Abierta ahora' : 'Cerrada ahora' }));
    this.ask('sucursal', M.list('¿De qué sucursal quieres pedir?', 'Ver sucursales', rows), rows);
  }

  async selectBranch(b) {
    if (!b.status.open) {
      const today = b.status.today;
      this.send(M.text(`${b.name} está cerrada en este momento.${today ? ` Hoy abre de ${today.opens_at} a ${today.closes_at}.` : ''}`));
      return this.backToMenu('Te espero en nuestro horario.');
    }
    if (this.ctx.branch_id !== b.id) {
      this.ctx.cart = [];
      this.ctx.location = null;
    }
    this.ctx.branch_id = b.id;
    this._menu = null;
    const s = await this.onlineSettings();
    const pickup = s.allow_pickup;
    const delivery = s.allow_delivery && b.delivery_enabled && this.mods.delivery;
    if (pickup && delivery) {
      const opts = [{ id: 'tipo:para_llevar', title: 'Paso a recoger' }, { id: 'tipo:domicilio', title: 'A domicilio' }];
      return this.ask('tipo', M.buttons(`Pedido en *${b.name}*. ¿Pasas a recoger o te lo llevamos?`, opts), opts);
    }
    if (!pickup && !delivery) {
      this.send(M.text(`${b.name} no está recibiendo pedidos por ahora.`));
      return this.backToMenu();
    }
    this.ctx.order_type = pickup ? 'para_llevar' : 'domicilio';
    return this.showCategories();
  }

  async showCategories(page = 0, intro = null) {
    const { categories } = await this.menu();
    if (!categories.length) {
      this.send(M.text('Por ahora no hay productos disponibles en esta sucursal.'));
      return this.backToMenu();
    }
    const slice = categories.slice(page * PAGE, page * PAGE + PAGE);
    const rows = slice.map((c) => ({ id: `c:${c.id}`, title: c.name, description: c.description || undefined }));
    if (categories.length > (page + 1) * PAGE) rows.push({ id: `cpage:${page + 1}`, title: 'Ver más categorías' });
    else if (page > 0) rows.push({ id: 'cpage:0', title: 'Volver al inicio' });
    if (this.cart.length) rows.push({ id: 'carrito', title: 'Ver mi pedido', description: M.money(cartSubtotal(this.cart)) });
    this.ask('categoria', M.list(intro || '¿Qué se te antoja? Elige una categoría o escribe lo que buscas.', 'Ver menú', rows), rows);
  }

  async showProducts(categoryId, page = 0) {
    const { categories, items } = await this.menu();
    const cat = categories.find((c) => c.id === categoryId);
    if (!cat) return this.showCategories();
    this.ctx.category_id = cat.id;
    const all = items.filter((i) => i.category_id === cat.id);
    const rows = all.slice(page * PAGE, page * PAGE + PAGE)
      .map((i) => ({ id: `p:${i.id}`, title: i.name, description: [M.money(i.price), i.description].filter(Boolean).join(' · ') }));
    if (all.length > (page + 1) * PAGE) rows.push({ id: `ppage:${page + 1}`, title: 'Ver más' });
    rows.push({ id: 'cats', title: 'Otras categorías' });
    this.ask('producto', M.list(`*${cat.name}*: elige un producto.`, 'Ver productos', rows), rows);
  }

  async search(text) {
    const terms = normalize(text).split(' ').filter((t) => t.length >= 3);
    if (!terms.length) return false;
    const { items } = await this.menu();
    const found = items.filter((i) => { const n = normalize(i.name); return terms.every((t) => n.includes(t)); });
    if (!found.length) {
      await this.showCategories(0, `No encontré "${text.slice(0, 40)}". Elige una categoría:`);
      return true;
    }
    if (found.length === 1) {
      await this.selectProduct(found[0].id);
      return true;
    }
    const rows = found.slice(0, 9).map((i) => ({ id: `p:${i.id}`, title: i.name, description: M.money(i.price) }));
    rows.push({ id: 'cats', title: 'Otras categorías' });
    this.ask('producto', M.list(`Encontré ${found.length} productos:`, 'Ver productos', rows), rows);
    return true;
  }

  async selectProduct(itemId) {
    const { items, groups } = await this.menu();
    const item = items.find((i) => i.id === itemId);
    if (!item) {
      this.send(M.text('Ese producto ya no está disponible.'));
      return this.showCategories();
    }
    const gids = item.modifier_group_ids.filter((g) => groups.get(g)?.modifiers.length);
    this.ctx.current = { id: item.id, name: item.name, price: Number(item.price), groups: gids, gi: 0, sel: {} };
    return gids.length ? this.promptGroup() : this.promptQuantity();
  }

  async promptGroup() {
    const cur = this.ctx.current;
    const g = (await this.menu()).groups.get(cur.groups[cur.gi]);
    const sel = cur.sel[g.id] || [];
    const multi = g.max_selections !== 1;
    const options = g.modifiers.filter((m) => !sel.includes(m.id));
    const rows = options.slice(0, 9).map((m) => ({
      id: `m:${m.id}`, title: m.name, description: Number(m.price_delta) > 0 ? `+${M.money(m.price_delta)}` : undefined,
    }));
    if (sel.length >= g.min_selections) {
      rows.splice(9);
      rows.push(multi && sel.length ? { id: 'm:done', title: 'Listo' } : { id: 'm:none', title: 'Ninguno' });
    }
    const chosen = sel.length ? `\nLlevas: ${sel.map((id) => g.modifiers.find((m) => m.id === id)?.name).join(', ')}` : '';
    const rule = multi
      ? (g.max_selections ? `elige hasta ${g.max_selections}` : 'elige los que quieras')
      : 'elige una opción';
    this.ask('modificador', M.list(`*${cur.name}*: ${g.name} (${rule}${g.min_selections ? ', obligatorio' : ''}).${chosen}`, g.name, rows), rows);
  }

  async chooseModifier(id) {
    const cur = this.ctx.current;
    const g = (await this.menu()).groups.get(cur.groups[cur.gi]);
    const sel = cur.sel[g.id] || [];
    if (id === 'm:none' || id === 'm:done') {
      if (sel.length < g.min_selections) return this.promptGroup();
      return this.nextGroup();
    }
    const mod = g.modifiers.find((m) => `m:${m.id}` === id);
    if (!mod) return this.promptGroup();
    if (!sel.includes(mod.id)) sel.push(mod.id);
    cur.sel[g.id] = sel;
    if (g.max_selections === 1 || (g.max_selections && sel.length >= g.max_selections) || sel.length >= g.modifiers.length) {
      return this.nextGroup();
    }
    return this.promptGroup();
  }

  async nextGroup() {
    this.ctx.current.gi += 1;
    return this.ctx.current.gi >= this.ctx.current.groups.length ? this.promptQuantity() : this.promptGroup();
  }

  promptQuantity() {
    const opts = ['1', '2', '3'].map((n) => ({ id: `q:${n}`, title: n }));
    this.ask('cantidad', M.buttons(`¿Cuántos *${this.ctx.current.name}*? Toca un botón o escribe la cantidad.`, opts), opts);
  }

  async addToCart(qty) {
    const cur = this.ctx.current;
    const { groups } = await this.menu();
    const mods = cur.groups.flatMap((gid) => (cur.sel[gid] || []).map((id) => groups.get(gid).modifiers.find((m) => m.id === id)).filter(Boolean));
    this.cart.push({
      menu_item_id: cur.id,
      name: cur.name,
      quantity: qty,
      modifier_ids: mods.map((m) => m.id),
      modifier_names: mods.map((m) => m.name),
      unit_price: cur.price + mods.reduce((s, m) => s + Number(m.price_delta), 0),
    });
    this.ctx.current = null;
    this.promptCart(`Agregué ${qty} × ${cur.name}.`);
  }

  promptCart(intro = 'Tu pedido:') {
    if (!this.cart.length) return this.showCategories();
    const opts = [{ id: 'mas', title: 'Agregar más' }, { id: 'pagar', title: 'Terminar pedido' }, { id: 'vaciar', title: 'Vaciar pedido' }];
    return this.ask('carrito', M.buttons(`${intro}\n\n${cartLines(this.cart)}\n\nLlevas ${M.money(cartSubtotal(this.cart))}.`, opts), opts);
  }

  /** Pide lo primero que falte para cerrar el pedido; si no falta nada, confirma. */
  async checkout() {
    if (!this.cart.length) return this.showCategories();
    if (this.ctx.order_type === 'domicilio') {
      const zone = await this.zone();
      if (zone && !this.ctx.location) {
        const opts = [];
        return this.ask('ubicacion', M.askLocation('Comparte tu ubicación para calcular el envío (toca *Enviar ubicación*).'), opts);
      }
      if (!this.ctx.address) {
        return this.ask('direccion', M.text('Escribe tu dirección: calle, número, colonia y alguna referencia para encontrarte.'), []);
      }
    }
    if (!this.ctx.name) {
      const profile = this.conv.profile_name?.trim();
      const opts = profile ? [{ id: 'nombre:perfil', title: profile }] : [];
      const body = `¿A nombre de quién va el pedido?${profile ? ' Toca tu nombre o escribe otro.' : ' Escribe tu nombre.'}`;
      return this.ask('nombre', profile ? M.buttons(body, opts) : M.text(body), opts);
    }
    if (!this.ctx.payment) return this.promptPayment();
    return this.confirm();
  }

  async quote() {
    return prepareOrder(this.db, { tenant: this.tenant, customer: null }, readOrderInput(this.orderBody(), null), this.mods.order);
  }

  orderBody() {
    const c = this.ctx;
    return {
      branch_id: c.branch_id,
      order_type: c.order_type,
      items: c.cart.map((l) => ({ menu_item_id: l.menu_item_id, quantity: l.quantity, modifier_ids: l.modifier_ids })),
      customer: { name: c.name, phone: `+${this.conv.wa_id}` },
      address: c.order_type === 'domicilio' ? { address: c.address } : undefined,
      location: c.order_type === 'domicilio' && c.location ? c.location : undefined,
      payment: c.payment ? { provider: c.payment.provider, method: c.payment.method, pay_with: c.payment.pay_with } : {},
      notes: 'Pedido por WhatsApp',
    };
  }

  async promptPayment() {
    let total;
    try {
      total = (await this.quote()).totals.total;
    } catch (err) {
      return this.orderProblem(err);
    }
    const clip = onlinePaymentAvailable(await getPaymentSettings(this.db, this.rid));
    const opts = [{ id: 'pago:efectivo', title: 'Efectivo' }, { id: 'pago:tarjeta', title: 'Tarjeta al recibir' }];
    if (clip) opts.push({ id: 'pago:clip', title: 'Pagar en línea' });
    this.ask('pago', M.buttons(`Total: *${M.money(total)}*. ¿Cómo vas a pagar?`, opts), opts);
  }

  async confirm() {
    let p;
    try {
      p = await this.quote();
    } catch (err) {
      return this.orderProblem(err);
    }
    const c = this.ctx;
    const pay = c.payment.provider === 'clip' ? 'En línea (te mando la liga al confirmar)'
      : c.payment.method === 'tarjeta' ? 'Tarjeta al recibir'
        : `Efectivo${c.payment.pay_with ? ` (pagas con ${M.money(c.payment.pay_with)})` : ' (exacto)'}`;
    const lines = p.lines.map((l) => `${l.quantity} × ${l.name}${l.modifiers.length ? ` (${l.modifiers.map((m) => m.name).join(', ')})` : ''} — ${M.money(l.line_total)}`);
    const body = [
      `Tu pedido en *${p.branch.name}*:`,
      lines.join('\n'),
      '',
      `Subtotal ${M.money(p.totals.subtotal)}`,
      Number(p.totals.delivery_fee) > 0 ? `Envío ${M.money(p.totals.delivery_fee)}` : null,
      `*Total ${M.money(p.totals.total)}*`,
      '',
      c.order_type === 'domicilio' ? `Entregar en: ${c.address}` : `Recoges en ${p.branch.name}`,
      `Pago: ${pay}`,
      `A nombre de: ${c.name}`,
    ].filter((x) => x !== null).join('\n');
    const opts = [{ id: 'confirmar', title: 'Confirmar pedido' }, { id: 'editar', title: 'Cambiar algo' }, { id: 'cancelar', title: 'Cancelar' }];
    this.ask('confirmar', M.buttons(body, opts), opts);
  }

  promptEdit() {
    const rows = [
      { id: 'edit:carrito', title: 'Productos' },
      { id: 'edit:tipo', title: 'Recoger o domicilio' },
      ...(this.ctx.order_type === 'domicilio' ? [{ id: 'edit:direccion', title: 'Dirección' }] : []),
      { id: 'edit:pago', title: 'Forma de pago' },
      { id: 'edit:nombre', title: 'Nombre' },
    ];
    this.ask('editar', M.list('¿Qué quieres cambiar?', 'Elegir', rows), rows);
  }

  async edit(id) {
    if (id === 'edit:carrito') return this.promptCart();
    if (id === 'edit:tipo') {
      const b = await this.branch();
      if (b) return this.selectBranchType(b);
    }
    if (id === 'edit:direccion') { this.ctx.address = null; this.ctx.location = null; }
    if (id === 'edit:pago') this.ctx.payment = null;
    if (id === 'edit:nombre') this.ctx.name = null;
    return this.checkout();
  }

  async selectBranchType(b) {
    const cart = this.cart;
    await this.selectBranch(b);
    this.ctx.cart = cart;
    if (this.state === 'categoria') return this.checkout();
    return undefined;
  }

  /** Un error al cotizar o crear: se explica y se regresa al paso que lo arregla. */
  async orderProblem(err) {
    if (!(err instanceof HttpError)) throw err;
    this.send(M.text(err.message));
    switch (err.code) {
      case 'LOCATION_REQUIRED':
      case 'OUT_OF_ZONE':
        this.ctx.location = null;
        if (err.code === 'OUT_OF_ZONE') {
          const opts = [{ id: 'edit:tipo', title: 'Cambiar a recoger' }, { id: 'edit:direccion', title: 'Otra ubicación' }];
          return this.ask('editar', M.buttons('¿Qué hacemos?', opts), opts);
        }
        return this.checkout();
      case 'BELOW_MIN_ORDER':
      case 'ITEM_NOT_FOUND':
      case 'ITEM_UNAVAILABLE':
      case 'MODIFIER_NOT_FOUND':
      case 'INVALID_MODIFIERS':
        return this.promptCart('Revisa tu pedido:');
      case 'INVALID_PAYMENT':
        this.ctx.payment = null;
        return this.promptPayment();
      case 'ADDRESS_REQUIRED':
        this.ctx.address = null;
        return this.checkout();
      default:
        return this.backToMenu();
    }
  }

  async placeOrder() {
    let result;
    try {
      // Valida antes de crear: los errores regresan al paso que corresponde.
      await this.quote();
      result = await createOnlineOrder(
        { tenant: this.tenant, customer: null }, readOrderInput(this.orderBody(), null), { channel: 'whatsapp' },
      );
    } catch (err) {
      return this.orderProblem(err);
    }
    const { payment, full } = result;
    const track = `${this.siteUrl}/pedido/${full.public_token}`;
    const name = this.ctx.name;
    this.ctx.cart = [];
    this.ctx.payment = null;
    this.ctx.current = null;
    this.ctx.last_order_id = full.id;
    if (payment?.action === 'redirect' && payment.url) {
      this.send(M.link(`¡Gracias, ${name}! Tu pedido *#${full.folio}* por ${M.money(full.total)} queda apartado. Págalo aquí para que lo preparemos:`, 'Pagar ahora', payment.url));
      this.send(M.text(`Síguelo aquí: ${track}`));
    } else {
      this.send(M.text(`¡Listo, ${name}! Recibimos tu pedido *#${full.folio}* por ${M.money(full.total)}. Te aviso por aquí cuando lo acepten.\n\nSíguelo aquí: ${track}`));
    }
    this.state = 'inicio';
    this.ctx.options = [{ id: 'menu', title: 'Menú principal' }];
    return undefined;
  }

  // --- entrada ---

  async handle(input) {
    const idle = this.conv.last_inbound_at && this.now - new Date(this.conv.last_inbound_at) > IDLE_MS;
    if (idle) {
      this.state = 'inicio';
      this.ctx.current = null;
    }
    const t = normalize(input.text);
    // En los pasos de texto libre (direccion, nombre) solo cuentan los botones.
    const cmd = input.kind === 'text' && !['direccion', 'nombre'].includes(this.state);

    // Comandos que sirven en cualquier paso.
    if (input.id === 'humano' || (cmd && HUMAN.test(t))) return this.handoff();
    if (input.id === 'menu' || (cmd && GREETING.test(t) && t.split(' ').length <= 4)) return this.mainMenu();
    if (input.id === 'cancelar' || (cmd && t === 'cancelar')) {
      this.ctx.cart = [];
      this.ctx.current = null;
      this.ctx.payment = null;
      return this.mainMenu('Listo, cancelé tu pedido. ¿Te ayudo con algo más?');
    }
    if (cmd && (t === 'carrito' || (t === 'mi pedido' && this.cart.length))) return this.promptCart();
    if (input.kind === 'media') {
      this.send(M.text('Por ahora solo entiendo texto y botones. Si necesitas ayuda, escribe *asesor* y te atiende una persona.'));
      return undefined;
    }

    const handler = this[`on_${this.state}`];
    if (!handler) return this.mainMenu();
    const done = await handler.call(this, input, t);
    if (done === false) {
      this.send(M.text('No te entendí. Elige una opción de la lista o escribe *menú* para empezar de nuevo.'));
      return this.repeat();
    }
    return undefined;
  }

  /** Vuelve a mandar la pregunta del paso actual. */
  async repeat() {
    switch (this.state) {
      case 'sucursal': return this.startOrder();
      case 'tipo': { const b = await this.branch(); return b ? this.selectBranch(b) : this.startOrder(); }
      case 'categoria': return this.showCategories();
      case 'producto': return this.ctx.category_id ? this.showProducts(this.ctx.category_id) : this.showCategories();
      case 'modificador': return this.promptGroup();
      case 'cantidad': return this.promptQuantity();
      case 'carrito': return this.promptCart();
      case 'ubicacion': case 'direccion': case 'nombre': return this.checkout();
      case 'pago': return this.promptPayment();
      case 'cambio': return this.promptChange();
      case 'confirmar': return this.confirm();
      case 'editar': return this.promptEdit();
      default: return this.mainMenu();
    }
  }

  async on_inicio(input) {
    const id = this.optionFor(input);
    if (id === 'pedir') return this.startOrder();
    if (id === 'seguir') return this.cart.length ? this.promptCart() : this.startOrder();
    if (id === 'estado') return this.orderStatus();
    if (id === 'horario') return this.hours();
    if (id?.startsWith('faq:')) {
      const f = (this.settings.faqs || [])[Number(id.slice(4))];
      if (f) {
        this.send(M.text(f.answer));
        return this.backToMenu();
      }
    }
    // Lo que no es una opcion en el inicio: saludo con el menu.
    return this.mainMenu();
  }

  async on_sucursal(input) {
    const id = this.optionFor(input);
    const b = id?.startsWith('b:') && (await this.branches()).find((x) => `b:${x.id}` === id);
    if (!b) return false;
    return this.selectBranch(b);
  }

  async on_tipo(input) {
    const id = this.optionFor(input);
    if (id !== 'tipo:para_llevar' && id !== 'tipo:domicilio') return false;
    this.ctx.order_type = id.slice(5);
    if (this.ctx.order_type === 'para_llevar') this.ctx.location = null;
    if (this.cart.length) return this.checkout();
    return this.showCategories();
  }

  async on_categoria(input) {
    const id = this.optionFor(input);
    if (id?.startsWith('c:')) return this.showProducts(id.slice(2));
    if (id?.startsWith('cpage:')) return this.showCategories(Number(id.slice(6)) || 0);
    if (id === 'carrito') return this.promptCart();
    if (input.kind === 'text' && await this.search(input.text)) return undefined;
    return false;
  }

  async on_producto(input) {
    const id = this.optionFor(input);
    if (id?.startsWith('p:')) return this.selectProduct(id.slice(2));
    if (id?.startsWith('ppage:')) return this.showProducts(this.ctx.category_id, Number(id.slice(6)) || 0);
    if (id === 'cats') return this.showCategories();
    if (input.kind === 'text' && await this.search(input.text)) return undefined;
    return false;
  }

  async on_modificador(input) {
    if (!this.ctx.current) return this.showCategories();
    const id = this.optionFor(input);
    if (!id?.startsWith('m:')) return false;
    return this.chooseModifier(id);
  }

  async on_cantidad(input, t) {
    if (!this.ctx.current) return this.showCategories();
    const n = input.id?.startsWith('q:') ? Number(input.id.slice(2)) : Number(t);
    if (!Number.isInteger(n) || n < 1 || n > 50) return false;
    return this.addToCart(n);
  }

  async on_carrito(input) {
    const id = this.optionFor(input);
    if (id === 'mas') return this.showCategories();
    if (id === 'pagar') return this.checkout();
    if (id === 'vaciar') {
      this.ctx.cart = [];
      return this.showCategories(0, 'Listo, vacié tu pedido. ¿Qué se te antoja?');
    }
    if (input.kind === 'text' && await this.search(input.text)) return undefined;
    return false;
  }

  async on_ubicacion(input) {
    if (input.kind !== 'location') {
      this.send(M.text('Necesito tu ubicación para calcular el envío. Toca *Enviar ubicación* o el clip 📎 › Ubicación.'));
      return this.checkout();
    }
    const point = { latitude: input.location.latitude, longitude: input.location.longitude };
    const zone = await this.zone();
    if (zone) {
      try {
        quoteZone(zone, point);
      } catch (err) {
        return this.orderProblem(err);
      }
    }
    this.ctx.location = point;
    return this.checkout();
  }

  async on_direccion(input) {
    const text = String(input.text || '').trim();
    if (input.kind === 'location') return this.on_ubicacion(input);
    if (text.length < 8) {
      this.send(M.text('Escribe la dirección completa (calle, número y colonia).'));
      return this.checkout();
    }
    this.ctx.address = text.slice(0, 400);
    return this.checkout();
  }

  async on_nombre(input) {
    const id = this.optionFor(input);
    let name = id === 'nombre:perfil' ? this.conv.profile_name : String(input.text || '').trim();
    name = name?.slice(0, 120);
    if (!name || name.length < 2) return false;
    this.ctx.name = name;
    return this.checkout();
  }

  async on_pago(input) {
    const id = this.optionFor(input);
    if (id === 'pago:efectivo') {
      this.ctx.payment = { provider: 'contra_entrega', method: 'efectivo', pay_with: null };
      return this.promptChange();
    }
    if (id === 'pago:tarjeta') this.ctx.payment = { provider: 'contra_entrega', method: 'tarjeta', pay_with: null };
    else if (id === 'pago:clip') this.ctx.payment = { provider: 'clip', method: null, pay_with: null };
    else return false;
    return this.confirm();
  }

  async promptChange() {
    let total;
    try {
      total = (await this.quote()).totals.total;
    } catch (err) {
      return this.orderProblem(err);
    }
    this.ctx.total = total;
    const opts = [{ id: 'cambio:exacto', title: 'Pago exacto' }];
    return this.ask('cambio', M.buttons(`Total: *${M.money(total)}*. ¿Con cuánto vas a pagar? Escribe el monto para llevarte cambio.`, opts), opts);
  }

  async on_cambio(input, t) {
    if (this.optionFor(input) === 'cambio:exacto') {
      this.ctx.payment.pay_with = null;
      return this.confirm();
    }
    const n = Number(t.replace(/[$\s,]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return false;
    if (n < Number(this.ctx.total || 0)) {
      this.send(M.text(`El monto debe cubrir el total de ${M.money(this.ctx.total)}.`));
      return this.promptChange();
    }
    this.ctx.payment.pay_with = Math.round(n * 100) / 100;
    return this.confirm();
  }

  async on_confirmar(input) {
    const id = this.optionFor(input);
    if (id === 'confirmar') return this.placeOrder();
    if (id === 'editar') return this.promptEdit();
    return false;
  }

  async on_editar(input) {
    const id = this.optionFor(input);
    if (!id?.startsWith('edit:')) return false;
    return this.edit(id);
  }
}

/**
 * Procesa un mensaje del cliente. mods: { ordering, delivery, zonas, order }
 * (order: lo que prepareOrder necesita de los modulos). Regresa
 * { replies, state, context, mode, needs_attention }.
 */
export async function runBot(db, args, input) {
  const bot = new Bot(db, args);
  await bot.handle(input);
  return {
    replies: bot.replies,
    state: bot.state,
    context: bot.ctx,
    mode: bot.mode,
    needs_attention: bot.needsAttention,
  };
}
