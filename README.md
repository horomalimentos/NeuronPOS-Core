# NeuronPOS Core

Plataforma SaaS multi-restaurante de NeuronPOS. Cada restaurante se suscribe
mensualmente a los módulos que usa (POS, sitio web, portal de clientes,
recursos humanos, empleado del mes, domicilios) y el dueño de la plataforma
configura el precio de cada módulo.

Este repo es independiente del NeuronPOS de Horom Sushi: base de datos propia,
proceso pm2 propio y dominio propio. Usa el mismo stack (React + Vite +
TypeScript + Tailwind, Express ESM + `pg`, Postgres).

> **Estado: Fase 5 (domicilios).** Sobre la fase 1a (esquema
> multi-restaurante, resolución del restaurante, autenticación, módulos, Panel
> NeuronPOS, sucursales y usuarios), la 1b (POS), la 2 (sitio público y
> pedidos en línea), la 3 (cobro con Clip) y la 4 (recursos humanos, nómina y
> empleado del mes), cada restaurante puede entregar sus pedidos a domicilio
> con sus propios repartidores o con la flota de NeuronPOS, con seguimiento
> en vivo para el cliente. Ver
> [Punto de venta](#punto-de-venta-módulo-pos),
> [Sitio web y pedidos en línea](#sitio-web-y-pedidos-en-línea-fase-2),
> [Cobro con Clip](#cobro-con-clip-fase-3),
> [Recursos humanos](#recursos-humanos-nómina-y-empleado-del-mes-fase-4) y
> [Domicilios](#domicilios-fase-5).

## Estructura

```
backend/            API Express (ESM) + pg
  app.js            arma la app (server.js la levanta, las pruebas la importan)
  config/           variables de entorno y pool de Postgres (withTenant / withPlatform)
  middleware/       tenant.js, auth.js, requireModule.js
  routes/           platform.js (Panel), auth, me, branches (y horarios), users, public,
                    website (Sitio web), online (config. de pedidos), portal (clientes)
  routes/pos/       POS: menu, tables, orders (y cocina), online (pedidos web), cash, settings
  routes/delivery/  Domicilios del restaurante: settings, dispatch (caja), driver (app), cuts
  routes/fleet.js   App de la flota (audiencia fleet); platformFleet.js: la flota en el Panel
  services/         billing.js (cobro mensual), access.js (reglas 402), restaurants.js,
                    posMath.js (totales, pagos y corte de caja en centavos), hours.js
                    (abierto/cerrado), online.js, onlinePayments.js, siteContent.js
  services/delivery/ flow.js (estados), math.js (comisión, cortes y liquidaciones en
                    centavos), tenant.js (reparto propio), fleet.js (flota, ofertas, factura)
  scripts/          migrate.js, create-owner.js
  tests/            node:test (unitarias + integración con Postgres)
db/migrations/      SQL numerado (001_, 002_, ...), se aplica con npm run migrate
frontend/           React 18 + Vite + TS + Tailwind
  src/platform/     Panel NeuronPOS (dueño de la plataforma)
  src/restaurant/   Administración del restaurante
  src/pos/          Punto de venta: venta, cobro, caja, cocina, menú, mesas, ticket
  src/site/         Sitio público, menú en línea, checkout, seguimiento y cuenta del cliente
  src/delivery/     Reparto en caja, cortes de repartidores, ajustes de domicilios, mapa (Leaflet)
  src/driver/       App del repartidor (/repartidor), propio o de la flota
  src/home/         Página principal de neuronpos.app y /descargas
apps/desktop/       App de escritorio NeuronPOS / Neuron KDS (Electron, impresión directa)
apps/android/       App de Android NeuronPOS / Neuron KDS (WebView + impresión directa)
```

## Requisitos

- Node.js 20 o superior
- PostgreSQL 13 o superior (se usa `gen_random_uuid()` y la extensión `citext`)

## Puesta en marcha local

### 1. Base de datos

La app **no debe** conectarse con un superusuario ni con un rol con
`BYPASSRLS`, porque esos roles se saltan las políticas RLS (ver
[Aislamiento](#aislamiento-entre-restaurantes)). Crea un rol normal que sea
dueño de la base:

```sql
-- como postgres
CREATE ROLE neuron_app LOGIN PASSWORD 'cambiar' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE neuronpos_core OWNER neuron_app;
```

### 2. Backend

```bash
cd backend
cp .env.example .env        # ajusta DB_*, JWT_SECRET, PLATFORM_DOMAIN
npm install
npm run migrate             # aplica db/migrations/*.sql pendientes
npm run create-owner -- --email tu@correo.com --name "Alex"   # pide la contraseña
npm run dev                 # http://localhost:8100
```

`npm run migrate` registra cada archivo aplicado en la tabla
`schema_migrations`; cada archivo corre en su propia transacción. Para cambiar
el esquema agrega un archivo nuevo (`004_algo.sql`), nunca edites uno ya
aplicado.

`npm run create-owner` también sirve para cambiar la contraseña de un dueño
existente. Para automatizarlo, pasa la contraseña en `OWNER_PASSWORD`.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173 (proxy de /api a :8100)
```

- Panel NeuronPOS: <http://localhost:5173/panel>
- Restaurante por subdominio: <http://horom.localhost:5173/admin> (los
  navegadores resuelven `*.localhost` sin tocar `/etc/hosts`).
- Sitio y portal de clientes: <http://horom.localhost:5173/> y
  <http://horom.localhost:5173/pedir>.
- Alternativa: <http://localhost:5173/admin?restaurante=horom> guarda el slug y
  lo manda en el header `X-Restaurant-Slug`.

## Variables de entorno (`backend/.env`)

| Variable | Descripción | Default |
|---|---|---|
| `NODE_ENV` | `production` activa las protecciones de producción | `development` |
| `PORT` | Puerto HTTP | `8100` |
| `DATABASE_URL` | Conexión completa (tiene prioridad sobre `DB_*`) | — |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Conexión por partes | `localhost`, `5432`, `neuronpos_core` |
| `DB_POOL_MAX` | Conexiones máximas del pool | `10` |
| `REQUIRE_RLS_ROLE` | `true` = no arrancar si el rol de BD se salta RLS (en producción siempre aplica) | `false` |
| `JWT_SECRET` | Secreto para firmar los tokens (**obligatorio en producción**) | solo en dev: `dev-secret-cambiar` |
| `JWT_EXPIRES_IN` | Vigencia del token | `12h` |
| `CUSTOMER_JWT_EXPIRES_IN` | Vigencia de la sesión de un cliente del portal | `30d` |
| `LOGIN_RATE_LIMIT` | Intentos de login por IP cada 15 min (personal y clientes) | `20` |
| `PUBLIC_RATE_LIMIT` | Requests al sitio y al portal por IP y restaurante cada 15 min | `600` |
| `ORDER_RATE_LIMIT` | Pedidos en línea por IP y restaurante cada hora | `20` |
| `PLATFORM_DOMAIN` | Dominio base; los restaurantes viven en `<slug>.<dominio>` | `localhost` |
| `RESERVED_SUBDOMAINS` | Subdominios que nunca son restaurantes | `www,app,api,admin,panel,static,cdn,mail` |
| `ALLOW_SLUG_HEADER` | Acepta el header `X-Restaurant-Slug` | `true` fuera de producción |
| `TRIAL_DAYS` | Días de prueba al crear un restaurante en `trial` | `14` |
| `CORS_ORIGINS` | Orígenes permitidos separados por coma | en dev, cualquiera |
| `PUBLIC_API_URL` | URL pública del backend; con ella se arman las URLs de webhook que se dan de alta en Clip | `http://localhost:8100` |
| `RESTAURANT_URL_TEMPLATE` | URL del sitio de un restaurante (a donde regresa Clip); `{slug}` y `{domain}` se reemplazan, un dominio propio usa `https://<dominio>` | `https://{slug}.{domain}` |
| `CLIP_API_KEY`, `CLIP_SECRET_KEY` | Credenciales de la cuenta de Clip **de la plataforma** (cobro de mensualidades) | — |
| `CLIP_WEBHOOK_SECRET` | Si se define, los webhooks de la plataforma sin firma `x-clip-signature` válida se rechazan | — |
| `CLIP_API_URL` | API de Clip | `https://api.payclip.com` |
| `PAYMENT_SECRETS_KEY` | Llave de 32 bytes (base64 o hex) para cifrar las credenciales de Clip de cada restaurante. **No se cambia** una vez en uso | — |
| `BILLING_TIMEZONE` | Zona horaria de día de cobro, vencimiento y gracia | `America/Mexico_City` |
| `BILLING_AUTO` | `true` = generar facturas, marcar vencidas y suspender solas (cada hora) | `true` |
| `JOBS_ENABLED` | Jobs en segundo plano (cobro, conciliación con Clip, pedidos sin pagar) | `true` (`false` en pruebas) |
| `UPLOADS_DIR` | Carpeta de las fotos que suben los restaurantes (una subcarpeta por restaurante), servidas en `/api/uploads` | `./uploads` |
| `DOWNLOADS_DIR` | Carpeta de los instaladores de las apps, servidos en `/api/descargas` | `./descargas` |

## Aislamiento entre restaurantes

Una sola base de datos compartida. Toda tabla que pertenece a un restaurante
tiene `restaurant_id` (`restaurant_modules`, `delivery_settings`, `branches`,
`users`, `user_branches`, `subscription_invoices`, las 17 tablas del POS de
`004_pos.sql`, las 8 de la fase 2 en `005_sitio_portal.sql`, las de la fase 3 en
`006_cobro_clip.sql`, las 19 de la fase 4 y las de domicilios de `008_domicilios.sql`). La protección
tiene tres capas:

1. **Resolución del restaurante** (`middleware/tenant.js`), en este orden:
   - `Host`: `<slug>.<PLATFORM_DOMAIN>` o el `custom_domain` del restaurante.
   - Header `X-Restaurant-Slug` (solo si `ALLOW_SLUG_HEADER`, y solo si el
     Host no apunta a un restaurante).
   - Claim `rid` del JWT.

   El JWT de un usuario lleva el `restaurant_id`; si el restaurante resuelto
   por Host/header no coincide, la API responde `403 TENANT_MISMATCH`. Los
   tokens de usuario (`typ: user`), de plataforma (`typ: platform`) y de
   cliente del portal (`typ: customer`, audiencia `customer`) no son
   intercambiables. El portal nunca toma el restaurante del token: siempre
   del Host, y el token de un cliente solo sirve en ese restaurante.

2. **Consultas con filtro explícito**: cada consulta de las rutas del
   restaurante filtra por `restaurant_id = req.tenant.id`.

3. **Row Level Security en Postgres** (`003_rls.sql`, `004_pos.sql` y `005_sitio_portal.sql`), como red
   de seguridad si alguna consulta olvida el filtro:
   - Todas las rutas usan `withTenant(restaurantId, fn)` (`config/database.js`),
     que toma una conexión, abre una transacción y ejecuta
     `SELECT set_config('app.restaurant_id', $1, true)`. El `true` hace que el
     valor sea **local a la transacción**: muere con el `COMMIT`/`ROLLBACK` y
     una conexión del pool nunca arrastra el restaurante de otro request. Esto
     también funciona detrás de PgBouncer en modo transacción.
   - Las políticas permiten ver y escribir solo filas con
     `restaurant_id = current_setting('app.restaurant_id')`. Fuera de
     `withTenant` no se ve nada (**falla cerrado**).
   - El Panel NeuronPOS usa `withPlatform(fn)`, que activa `app.is_platform`
     para ver todos los restaurantes. Solo se usa detrás de
     `authenticatePlatform`.
   - `FORCE ROW LEVEL SECURITY` hace que las políticas apliquen también al
     dueño de las tablas (el mismo rol que corre la app y las migraciones).
     Por eso el rol **no** puede ser superusuario ni tener `BYPASSRLS`. El
     servidor lo revisa al arrancar y en producción se niega a iniciar si no
     se cumple.
   - Las relaciones internas usan llaves foráneas compuestas
     (`(restaurant_id, branch_id)`), así que una fila nunca puede apuntar a
     una sucursal o usuario de otro restaurante.

   `restaurants`, `modules` y `platform_admins` son tablas de plataforma y no
   tienen RLS: se leen para resolver el restaurante y desde el Panel.

## Módulos y cobro

| Código | Módulo |
|---|---|
| `pos` | Punto de venta |
| `landing` | Sitio web |
| `portal` | Portal de clientes y pedidos en línea |
| `rh` | Recursos humanos y nómina |
| `empleado_mes` | Empleado del mes |
| `domicilios` | Domicilios (`propio` o `horom`, con comisión fija o porcentual) |

Los precios del catálogo empiezan en 0; se ajustan en **Panel → Módulos y
precios**.

**Mensualidad de un restaurante** = suma de sus módulos *vigentes*
(habilitados, con `started_at` ya cumplido y sin `ends_at` vencido). Por
módulo se usa `custom_price_mxn` si existe, si no el precio de catálogo, y
luego se aplica `discount_pct`. Se calcula en centavos
(`services/billing.js`). La comisión por domicilios Horom es por pedido y no
forma parte de la mensualidad. En el total de la plataforma no se suman los
restaurantes suspendidos.

**`requireModule('pos')`** responde `402` con mensaje en español cuando:
- el restaurante está suspendido (`RESTAURANT_SUSPENDED`),
- el restaurante está en prueba y la prueba ya venció (`TRIAL_EXPIRED`),
- el módulo no está contratado o ya venció (`MODULE_NOT_ENABLED`).

El cobro de esa mensualidad (facturas, Clip, suspensión por falta de pago)
está en [Cobro con Clip](#cobro-con-clip-fase-3).

## API

Panel NeuronPOS (token de plataforma):

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/platform/auth/login` | Login del dueño |
| GET | `/api/platform/me` | Cuenta actual |
| GET | `/api/platform/modules` | Catálogo con número de restaurantes que lo usan |
| PUT | `/api/platform/modules/:code` | Precio, nombre, descripción, disponible, orden |
| GET | `/api/platform/restaurants` | Lista con estado y mensualidad + total de la plataforma |
| POST | `/api/platform/restaurants` | Crear (módulos iniciales, primera sucursal y admin opcional) |
| GET | `/api/platform/restaurants/:id` | Detalle: módulos, domicilios, cobro, conteos, facturas |
| PATCH | `/api/platform/restaurants/:id` | Datos, marca, dominio, estado, prueba |
| DELETE | `/api/platform/restaurants/:id?confirm=<slug>` | Borrado definitivo |
| POST | `/api/platform/restaurants/:id/suspend` · `/reactivate` | Suspender / reactivar |
| PUT | `/api/platform/restaurants/:id/modules/:code` | `enabled`, `custom_price_mxn`, `discount_pct`, `ends_at` |
| PUT | `/api/platform/restaurants/:id/delivery` | `mode`, `horom_fee_type`, `horom_fee_value` |
| GET | `/api/platform/restaurants/:id/charge` | Desglose de la mensualidad |

Restaurante (restaurante resuelto por Host, header o token):

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/login` | Login de usuario del restaurante |
| GET | `/api/me` | Usuario, restaurante (marca y estado), módulos (sin precios), sucursales |
| GET/POST/PATCH/DELETE | `/api/branches[/:id]` | Sucursales (escritura: admin y gerente; borrar: admin) |
| GET/POST/PATCH/DELETE | `/api/users[/:id]` | Usuarios (lectura: admin y gerente; escritura: admin) |
| GET | `/api/public/site` | Público: marca, módulos, sucursales con horario, SEO, si hay pedidos en línea |
| GET | `/api/public/landing` | Público (módulo `landing`): contenido, galería, menú de muestra y sucursales |
| GET/PUT | `/api/branches/:id/hours` | Horario semanal y días cerrados (editar: admin y gerente) |
| | `/api/pos/*` | Punto de venta, ver abajo |
| | `/api/website/*`, `/api/online/*`, `/api/portal/*` | Sitio web y pedidos en línea, ver abajo |
| GET | `/api/health` | Estado del servidor y la BD |

Roles de usuario: `admin`, `gerente`, `cajero`, `mesero`, `cocina`,
`repartidor`. Los `admin` tienen acceso a todas las sucursales; el resto, a
las de `user_branches` (la primera es la principal).

## Punto de venta (módulo `pos`)

Todas las rutas `/api/pos/*` pasan por `authenticateUser` y
`requireModule('pos')` (402 si el restaurante no lo tiene, está suspendido o
venció su prueba). Las pantallas del frontend (`/admin/pos`, `/admin/cocina`,
`/admin/caja`, `/admin/menu`, `/admin/mesas`, `/admin/pos/ajustes`) solo se
muestran con el módulo contratado.

**Tablas** (`004_pos.sql`, todas con RLS): `pos_settings`, `menu_categories`,
`menu_items`, `menu_item_branches` (disponibilidad por sucursal),
`modifier_groups`, `modifiers`, `menu_item_modifier_groups`,
`restaurant_zones`, `restaurant_tables`, `payment_methods`, `cash_sessions`,
`cash_movements`, `cash_session_counts`, `orders`, `order_items`,
`order_item_modifiers`, `order_payments`. Al crear un restaurante se siembran
la configuración y los métodos Efectivo, Tarjeta y Transferencia
(`seed_pos_defaults`).

**Reglas principales**
- Precios siempre del lado del servidor: el cliente manda producto,
  cantidad, modificadores y notas. Se validan mínimo/máximo por grupo y la
  disponibilidad en la sucursal. Nombre y precios se copian a la orden.
- Tipos de orden: `comedor` (con mesa), `para_llevar`, `domicilio` (nombre y
  dirección del cliente; la logística de reparto llega con el módulo
  Domicilios). Folio consecutivo por sucursal.
- Estados: `abierta → enviada → lista → pagada`, o `cancelada` con motivo.
  Una mesa solo tiene una orden activa (índice único); está ocupada mientras
  la tenga. Al cobrar, lo no enviado se manda a cocina.
- Totales en centavos (`services/posMath.js`): IVA configurable, incluido en
  el precio (se desglosa) o encima del subtotal; la tasa se fija al crear la
  orden. Descuento por porcentaje o cantidad: admin/gerente sin límite, cajero
  hasta `cashier_max_discount_pct` (0 = no puede), mesero no.
- Pagos: uno o varios (cuenta dividida), cada uno con propina; solo el
  efectivo da cambio. Requieren un turno de caja abierto de la sucursal.
- Caja: un turno abierto por terminal y sucursal. Esperado por método =
  ventas + propinas; en efectivo además fondo + entradas − salidas. Al cerrar
  se captura lo contado por método y se guarda la diferencia.
- Artículos ya enviados a cocina solo los cancela admin/gerente con motivo.
  Productos, mesas y métodos con historial se desactivan en lugar de borrarse.

| Método | Ruta | Roles |
|---|---|---|
| GET | `/api/pos/menu[?branch_id=&all=1]` | todos menos repartidor (`all=1` admin/gerente) |
| POST/PATCH/DELETE | `/api/pos/categories[/:id]`, `/items[/:id]`, `/modifier-groups[/:id]` | admin, gerente |
| PUT | `/api/pos/items/:id/availability` | admin, gerente, cajero |
| GET | `/api/pos/tables?branch_id=` (zonas, mesas y su estado) | admin, gerente, cajero, mesero |
| POST/PATCH/DELETE | `/api/pos/zones[/:id]`, `/api/pos/tables[/:id]` | admin, gerente |
| GET/PATCH | `/api/pos/settings` | leer: todos; editar: admin, gerente |
| GET/POST/PATCH/DELETE | `/api/pos/payment-methods[/:id]` | leer: todos; editar: admin, gerente |
| GET/POST | `/api/pos/orders` (`?branch_id=&status=activas\|pagada\|cancelada\|todas&date=`) | admin, gerente, cajero, mesero |
| GET/PATCH | `/api/pos/orders/:id` | ídem (GET también cocina) |
| POST | `/api/pos/orders/:id/items` · PATCH/DELETE `/items/:itemId` | ídem |
| POST | `/api/pos/orders/:id/send` · `/cancel` | ídem |
| POST | `/api/pos/orders/:id/ready` | admin, gerente, cocina |
| PUT/DELETE | `/api/pos/orders/:id/discount` | admin, gerente, cajero (con límite) |
| POST | `/api/pos/orders/:id/payments` | admin, gerente, cajero |
| GET | `/api/pos/kitchen?branch_id=` | todos menos repartidor |
| GET/POST | `/api/pos/cash-sessions` · `/open` · `/:id` · `/:id/movements` · `/:id/close` | admin, gerente, cajero |
| GET | `/api/pos/reports/sales?from=&to=[&branch_id=]` | admin, gerente |
| POST | `/api/uploads/image` (cuerpo: la imagen, `Content-Type: image/*`, máx. 5 MB) | admin, gerente |

**Reportes de ventas** (`/admin/reportes` y el resumen del día en Inicio):
órdenes pagadas por fecha de cobro en la zona horaria de cada sucursal, con
comparación contra el periodo anterior de la misma duración; por día, hora y
día de la semana; métodos de pago, tipo de orden, sucursal, productos,
categorías, modificadores y persona que abrió la orden; canceladas y
artículos cancelados. Cada tabla se descarga en CSV. Rango máximo: 366 días.

**Fotos:** el menú y el sitio web suben fotos (el navegador las achica a
1600 px). Se guardan en `UPLOADS_DIR/<restaurante>/<uuid>.<ext>`; se valida el
tipo real por los primeros bytes (JPG, PNG, WebP, GIF). Respalda esa carpeta
junto con la base de datos.

El ticket y el corte se imprimen desde el navegador (HTML de 80 mm en un
iframe oculto) con el logo, nombre y color del restaurante; no hay servicio de
impresión nativo. La pantalla de cocina se actualiza cada 5 segundos.

## Sitio web y pedidos en línea (fase 2)

Cada restaurante tiene su sitio en su dominio o subdominio (el restaurante se
resuelve por `Host`, igual que el resto de la API). Marca (logo y colores) del
restaurante; contenido editable por el restaurante.

**Tablas** (`005_sitio_portal.sql`, todas con RLS y llaves compuestas):
`site_content` (JSON validado por `services/siteContent.js`), `site_gallery`,
`branch_hours` (un horario por día; cierre antes que apertura = cierra después
de medianoche; misma hora = 24 h), `branch_closures` (días cerrados),
`online_settings`, `branch_online_settings` (recibe pedidos, entrega a
domicilio, costo de envío fijo), `customers` (correo único **por
restaurante**, contraseña bcrypt) y `customer_addresses`. En `orders` se
agregan `source` (`pos` | `web`), `online_status` (`pendiente` → `aceptada`
o `rechazada`), `customer_id`, `delivery_fee`, `delivery_reference`,
`payment_provider`, `payment_preference`, `pay_with`, `public_token`,
`accepted_at/by`, `estimated_ready_at` y `dispatched_at`; `created_by` puede
ser NULL solo en pedidos web.

**Sitio web (módulo `landing`)**: `/` muestra portada (imagen, título,
subtítulo y botón "Ordenar en línea" si hay pedidos en línea), acerca de, menú
de muestra (del menú del POS, solo lectura), galería, sucursales con
dirección, teléfono, enlace a Google Maps y horario (abierto/cerrado
calculado en la zona horaria de la sucursal), redes y pie. `<title>` y meta
description/og se fijan por restaurante al cargar (`seo_title`,
`seo_description`). Sin el módulo, `/` muestra solo el nombre y el enlace para
ordenar (si tiene portal) o "Sitio no disponible". Se edita en
**Admin → Sitio web**; las imágenes son URLs por ahora.

**Portal de clientes (módulo `portal`)**: registro, inicio de sesión,
perfil, direcciones, historial y seguimiento con estado en vivo (sondeo cada
8 s). Menú en línea por sucursal (respeta productos agotados), detalle con
modificadores (mínimo/máximo), carrito en `localStorage`, checkout para
recoger o a domicilio (este requiere además el módulo `domicilios` y que la
sucursal entregue) y pago al recibir (efectivo, con "¿con cuánto pagas?", o
tarjeta). Se permite pedir como invitado con nombre y teléfono: el
seguimiento usa un token aleatorio. La configuración (encender/apagar, pedido
mínimo, tiempo de preparación, aceptar automáticamente o manualmente, recoger
/ domicilio y costo de envío por sucursal) está en **Admin → Pedidos en
línea**; el horario, en **Sucursales → Horario**.

Reglas:
- Precios siempre del servidor: el pedido se valúa con el mismo
  `priceItems` del POS y `posMath` (el costo de envío se suma al final, sin
  descuento ni IVA). Cualquier precio que mande el cliente se ignora.
  `POST /api/portal/quote` da los totales al checkout.
- Solo se aceptan pedidos con la sucursal **abierta** (sin horario
  configurado = cerrada), con los pedidos en línea encendidos, el módulo `pos`
  activo y el mínimo cubierto.
- El pedido entra al POS como orden con `source = 'web'`. Si no es automático
  queda `pendiente`: no aparece en "Abiertas", no va a cocina y no se cobra
  hasta aceptarlo en **Vender → En línea** (insignia con el número de
  pendientes). Aceptar lo manda a cocina y fija la hora estimada; rechazar
  exige motivo, que el cliente ve. Los de domicilio se marcan "salió a
  reparto". Se cobran con el flujo normal de caja; pagado = entregado.
- Estado para el cliente: recibido → en preparación → listo para recoger / en
  camino → entregado; o rechazado / cancelado (el cliente puede cancelar
  mientras no se acepte).
- Pagos en línea: `services/onlinePayments.js` define la interfaz de un
  proveedor (`validate`, `start`); hoy solo existe `contra_entrega`. Una
  pasarela se agrega como otro proveedor (más su webhook).
- Límites por restaurante e IP: lecturas públicas, login/registro de
  clientes y creación de pedidos (ver variables de entorno).

| Método | Ruta | Descripción |
|---|---|---|
| GET/PATCH | `/api/website`, `/api/website/content` | Contenido del sitio (admin, gerente; módulo `landing`) |
| POST/PATCH/DELETE | `/api/website/gallery[/:id]` | Galería |
| GET/PATCH | `/api/online/settings` | Configuración de pedidos en línea (admin, gerente; módulo `portal`) |
| PUT | `/api/online/branches/:id` | `online_enabled`, `delivery_enabled`, `delivery_fee` |
| GET | `/api/portal/config` · `/api/portal/menu?branch_id=` | Sucursales (abierto, envío), opciones de pago; menú en línea |
| POST | `/api/portal/auth/register` · `/auth/login` | Cuenta del cliente (token `customer`) |
| GET/PATCH | `/api/portal/me` | Perfil (y cambio de contraseña con la actual) |
| POST/PATCH/DELETE | `/api/portal/me/addresses[/:id]` | Direcciones |
| POST | `/api/portal/quote` | Totales del servidor |
| POST | `/api/portal/orders` | Crear pedido (cliente o invitado) |
| GET | `/api/portal/orders[/:id]` | Historial del cliente |
| GET/POST | `/api/portal/track/:token` · `/cancel` | Seguimiento por token / cancelar antes de aceptar |
| GET | `/api/pos/online-orders?branch_id=&status=pendientes\|activas\|todas` | Lista para el POS + `pending_count` |
| POST | `/api/pos/online-orders/:id/accept` · `/reject` · `/dispatch` | admin, gerente, cajero |

Todo `/api/portal/*` pasa por `requireModule('portal')` (402) y
`/api/public/landing` por `requireModule('landing')`.

## Cobro con Clip (fase 3)

Migración `006_cobro_clip.sql`. Hay **dos cuentas de Clip distintas**:

| | Cuenta | Para qué | Credenciales |
|---|---|---|---|
| A | La de la plataforma (Alex) | Cobrar la mensualidad a cada restaurante | Variables `CLIP_*` del servidor |
| B | La de cada restaurante | Cobrar sus pedidos en línea | Las captura el admin del restaurante; se guardan cifradas |

Integración con Clip (`services/clip/`): `POST /v2/checkout` crea una liga de
pago (Basic `base64(API_KEY:SECRET_KEY)`) y `GET /v2/checkout/{id}` es la
fuente de verdad. Como en el NeuronPOS original, **el cuerpo del webhook no
se cree**: solo dispara la consulta a Clip con las credenciales de esa
cuenta, y se valida que el monto y la moneda coincidan. Además, si hay
webhook secret configurado, la firma HMAC-SHA256 (`x-clip-signature`, sobre
el cuerpo crudo) es obligatoria. Todas las ligas viven en `clip_checkouts`
(propósito `suscripcion` o `pedido`); aplicar un pago es idempotente
(`applied_at`), y un reconciliador cada 5 minutos revisa las ligas
pendientes por si un webhook no llegó. Cada webhook queda en
`clip_webhook_events` (con RLS).

### A. Mensualidad de los restaurantes

- **Factura mensual** (`subscription_invoices` + `subscription_invoice_items`):
  una línea por módulo vigente con precio de catálogo o especial y descuento,
  en centavos. Periodo de `billing_day` (1 a 31, por restaurante; si no hay,
  el día en que se activó; en meses cortos se recorre al último día) al día
  anterior del siguiente cobro; la fecha límite es el inicio del periodo.
  Una factura por restaurante y periodo (idempotente, también si el job
  corre dos veces). Mensualidad 0 = factura en ceros marcada pagada
  (`sin_cargo`).
- **Prueba**: al vencer `trial_ends_at`, el restaurante pasa a `active` y se
  genera su primera factura ese mismo día.
- **Cobranza** (`platform_settings.grace_days`, default 5): pasada la fecha
  límite la factura queda `overdue` y el restaurante ve un aviso; pasados
  los días de gracia se suspende solo (`suspended_reason = 'falta_pago'`).
  Al pagar (Clip o manual) se reactiva solo, pero **solo** si la suspensión
  fue por falta de pago: una suspensión manual del Panel no se levanta sola.
  Si Alex reactiva a mano a un moroso, tiene la gracia de nuevo
  (`dunning_grace_until`) antes de volver a suspenderse.
- **Restaurante suspendido**: la API sigue respondiendo 402 en los módulos y
  el admin solo puede entrar a **Mi suscripción** (`/admin/suscripcion`) para
  pagar.
- **Avisos**: `services/notifier.js` es la interfaz de notificaciones
  (factura nueva, vencida, suspendido, pagado). Hoy solo escribe en el log;
  ahí se conectará correo/WhatsApp.

### B. Pagos de pedidos en línea

- El admin del restaurante captura en **Pedidos en línea → Pago en línea
  con Clip** su API key, secret key y (opcional) webhook secret. Se cifran
  con AES-256-GCM (`PAYMENT_SECRETS_KEY`, ligadas al restaurante y al
  campo) y **nunca** se regresan por la API: solo "configurada / no".
- Con Clip configurado y activado, el checkout ofrece **Pagar en línea con
  Clip**. El pedido queda `online_payment_status = 'pendiente'`: no llega al
  POS hasta que Clip confirma. Al confirmarse se registra el pago con el
  método **Clip en línea** (tipo `en_linea`, sin turno de caja y fuera del
  corte) y sigue el flujo normal (o entra directo a cocina con aceptación
  automática). En el POS se entrega con **Entregar** sin cobrar.
- Si no se paga en `payment_timeout_minutes` (default 30) el pedido se
  cancela solo; si Clip confirmó justo antes, se cobra en lugar de
  cancelarse. Un pago que llega después de cancelado queda marcado
  (`late_payment`) para reembolsarlo a mano.
- Al volver de Clip el cliente llega a `/pago/resultado`, que le pide al
  servidor conciliar (no se cree en la URL). **Pago al recibir** sigue igual.

### Qué configura Alex

1. En el servidor: `CLIP_API_KEY`, `CLIP_SECRET_KEY` (de
   <https://dashboard.payclip.com>, Desarrolladores), `CLIP_WEBHOOK_SECRET`
   (recomendado), `PAYMENT_SECRETS_KEY` (generar una vez y respaldar),
   `PUBLIC_API_URL`, `RESTAURANT_URL_TEMPLATE`; opcionales
   `BILLING_TIMEZONE`, `BILLING_AUTO`, `JOBS_ENABLED`.
2. En **su** dashboard de Clip, webhook de la plataforma:
   `<PUBLIC_API_URL>/api/webhooks/clip/plataforma`.
3. A cada restaurante que cobre en línea: en **su** dashboard de Clip, webhook
   `<PUBLIC_API_URL>/api/webhooks/clip/r/<slug-del-restaurante>` (también
   acepta el id). La pantalla de pago en línea del restaurante y **Panel →
   Ajustes** muestran las URLs exactas.
4. En **Panel → Ajustes**: días de gracia. En el detalle de cada restaurante:
   día de cobro.

Clip solo tiene ambiente de producción: probar con montos pequeños.

### API de la fase 3

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| POST | `/api/webhooks/clip/plataforma` | Clip | Webhook de la cuenta de la plataforma |
| POST | `/api/webhooks/clip/r/:slug-o-id` | Clip | Webhook de la cuenta de un restaurante |
| GET | `/api/platform/invoices?status=&restaurant_id=` | Panel | Facturas y totales (por cobrar, vencido, cobrado del mes) |
| GET | `/api/platform/invoices/:id` | Panel | Detalle con líneas y ligas |
| POST | `/api/platform/restaurants/:id/invoices` | Panel | Generar cobro ahora (idempotente por periodo) |
| POST | `/api/platform/invoices/:id/mark-paid` | Panel | Pago manual con nota obligatoria; reactiva si aplica |
| POST | `/api/platform/invoices/:id/resend` | Panel | Reenviar liga (nueva si la anterior venció) |
| POST | `/api/platform/billing/run` | Panel | Correr el ciclo de cobro ya |
| GET/PUT | `/api/platform/settings` | Panel | Días de gracia; Clip solo como configurado / no |
| GET | `/api/subscription` | admin, gerente | Mi suscripción: módulos, total, facturas, avisos (también suspendido) |
| POST | `/api/subscription/invoices/:id/pay` · `/verify` | admin, gerente | Liga de Clip / conciliar al regresar |
| GET/PUT | `/api/online/payments` | lectura admin y gerente; escritura admin | Credenciales de Clip del restaurante (nunca se regresan) y minutos para pagar |
| POST | `/api/portal/track/:token/pay` · `/verify-payment` | cliente | Liga para terminar de pagar / conciliar |
| POST | `/api/pos/online-orders/:id/deliver` | admin, gerente, cajero | Entregar un pedido ya pagado en línea |

## Recursos humanos, nómina y empleado del mes (fase 4)

Dos módulos independientes: `rh` (empleados, checador, asistencia y
prenómina) y `empleado_mes` (ranking mensual y muro). Las rutas `/api/rh/*`
pasan por `requireModule('rh')`, `/api/recognition/*` por
`requireModule('empleado_mes')` y `/api/employees` acepta cualquiera de los
dos (`requireAnyModule`). Sin el módulo: 402. Todo el dinero se calcula en
centavos (`services/rh/payrollMath.js`). No hay integración con ningún reloj
checador en particular: queda una interfaz de importación con adaptadores
(`services/rh/clockImport.js`, hoy solo el formato `generico`).

**Tablas** (`007_rh_nomina.sql`, las 19 con RLS y llaves compuestas
`(restaurant_id, …)`): `hr_areas`, `employees`, `employee_schedules`,
`hr_clock_settings`, `time_entries`, `time_entry_audit`,
`attendance_justifications`, `payroll_settings`, `hr_holidays`,
`payroll_adjustments`, `payroll_periods`, `payroll_items`,
`payroll_item_lines`, `payroll_receipt_signatures`, `recognition_settings`,
`recognition_evaluations`, `recognition_tasks`, `recognition_months`,
`recognition_results`. Al crear un restaurante se siembran las reglas de
nómina y de reconocimiento (`seed_hr_defaults`).

**Empleados y checador**
- Empleado opcionalmente ligado a un usuario (para “Mi nómina”); puesto,
  área, sucursal, salario diario o tarifa por hora, frecuencia de pago
  (semanal, quincenal o mensual), ingreso/baja, NSS, RFC, CURP y datos
  bancarios. Con historial no se borra: se da de baja.
- Horario semanal por día (los días sin horario son descanso; turnos que
  cruzan la medianoche permitidos).
- Checador por sucursal (`/admin/checador`, pensado para una tableta): el
  empleado toca su nombre y teclea su NIP de 4 a 6 dígitos (guardado con
  bcrypt). 5 NIP erróneos bloquean 15 min (423). Entrada o salida se decide
  sola; dos checadas en menos de 60 s se rechazan (409). Restricción opcional
  por sucursal: radio en metros desde un punto (geolocalización del
  navegador) y/o lista de IP o CIDR (403 fuera de rango).
- Correcciones manuales (crear, editar, anular) solo admin/gerente, con
  motivo obligatorio y bitácora antes/después (`time_entry_audit`). No se
  puede tocar un día que ya está en una nómina aprobada (409
  `PERIOD_LOCKED`).

**Asistencia y prenómina**
- Retardo después de la tolerancia (10 min por defecto); falta si un día
  laboral no tiene checada; justificaciones por día con o sin goce de sueldo.
- Periodo semanal (día de inicio configurable), quincenal (1–15 y 16–fin) o
  mensual. Generar es idempotente: si el periodo ya existe se regresa el
  mismo (200 en vez de 201) y recalcular reemplaza sus líneas.
- Percepciones: sueldo por días pagados (o por horas), horas extra en
  bloques (dobles hasta 9 h por semana, luego triples), festivo trabajado
  (factor 2 por defecto), descanso trabajado, prima dominical (25 %), bonos de
  puntualidad y de asistencia, bonos manuales. Deducciones: retardos (monto
  fijo y/o proporcional a los minutos), faltas, descuentos y préstamos (el
  préstamo se descuenta por periodo hasta saldar el total). El neto nunca es
  negativo; lo que no alcanzó se reporta.
- Festivos oficiales de México calculados por año (1 ene, primer lunes de
  feb, tercer lunes de mar, 1 may, 16 sep, tercer lunes de nov, 25 dic y 1 oct
  cada 6 años), más festivos propios del restaurante.
- Flujo: borrador → aprobada (admin; los recibos quedan fijos y el empleado
  los ve) → cerrada (admin; requiere todo pagado). Reabrir solo si nadie ha
  firmado ni cobrado. Pago por recibo o “pagar pendientes”; con el módulo
  `pos` se puede pagar **desde caja**, que registra una salida de efectivo en
  el turno abierto.
- Salidas: CSV (Excel, con BOM y fila de totales) y recibos imprimibles desde
  el navegador. El empleado firma su recibo con una casilla de conformidad;
  se guarda la hora, el neto firmado, la IP y el navegador.

**Empleado del mes**
- Puntaje de 0 a 100 = promedio ponderado de asistencia y puntualidad (de
  `rh`), ventas (de `pos`, solo para usuarios mesero o cajero), evaluación
  del gerente (0–100 por mes) y tareas completadas. Pesos por defecto 30/20/
  20/20/10; un componente que no aplica a un empleado (sin módulo, sin
  usuario o sin días laborales) se quita y los demás pesos se reparten.
- Ranking por sucursal con desempates fijos (asistencia, puntualidad,
  nombre, id): el mismo dato da siempre el mismo ganador. Mínimo de días
  trabajados configurable para ganar.
- Cierre del mes: manual (admin) o automático por el job horario
  `empleado-del-mes` (cierra el mes anterior una sola vez). Guarda el ranking,
  el ganador por sucursal y el premio; si “premio a nómina” está activo y hay
  `rh`, el monto entra como bono en la siguiente nómina.
- Muro (`/admin/muro`, cualquier rol): ganador del último mes y cómo va el
  ranking del mes en curso; se actualiza cada minuto.

| Método | Ruta | Roles |
|---|---|---|
| GET/POST/PATCH/DELETE | `/api/employees[/:id]` | admin, gerente (borrar: admin) |
| PUT | `/api/employees/:id/schedule` · `/:id/pin` | admin, gerente |
| GET | `/api/rh/kiosk/:branchId` | cualquier usuario de la sucursal |
| POST | `/api/rh/kiosk/clock` (`{branch_id, employee_id, pin, latitude?, longitude?}`) | cualquier usuario de la sucursal |
| GET/POST/PATCH | `/api/rh/time-entries[/:id]` · POST `/:id/void` · GET `/:id/audit` | admin, gerente |
| POST | `/api/rh/time-entries/import` (`{adapter, branch_id, events}`) | admin |
| GET | `/api/rh/attendance?from=&to=&branch_id=&employee_id=` | admin, gerente |
| GET/POST/DELETE | `/api/rh/justifications[/:id]` | admin, gerente |
| GET/POST/PATCH/DELETE | `/api/rh/areas[/:id]` | admin, gerente |
| GET/PUT | `/api/rh/settings` | leer: admin, gerente; editar: admin |
| GET/POST/DELETE | `/api/rh/holidays[/:date]` | ídem |
| GET/PUT | `/api/rh/clock-settings[/:branchId]` | admin, gerente |
| GET/POST/PATCH/DELETE | `/api/rh/adjustments[/:id]` | admin, gerente |
| GET/POST | `/api/rh/payroll/periods` | admin, gerente |
| GET | `/api/rh/payroll/periods/:id` · `/export.csv` · `/api/rh/payroll/items/:id` | admin, gerente |
| POST | `/api/rh/payroll/periods/:id/calculate` | admin, gerente |
| POST | `/api/rh/payroll/periods/:id/approve` · `/reopen` · `/close` | admin |
| POST | `/api/rh/payroll/items/:id/pay` · `/periods/:id/pay-all` | admin, gerente |
| GET | `/api/rh/me` · `/me/attendance` · `/me/receipts[/:id]` | el empleado ligado al usuario |
| POST | `/api/rh/me/receipts/:id/sign` (`{accept: true}`) | ídem |
| GET/PUT | `/api/recognition/settings` | leer: admin, gerente; editar: admin |
| GET | `/api/recognition/ranking?year=&month=&branch_id=` · `/history` | admin, gerente |
| POST | `/api/recognition/months/:year/:month/close` | admin |
| GET/PUT | `/api/recognition/evaluations` | admin, gerente |
| GET/POST | `/api/recognition/tasks` · POST `/tasks/:id/complete\|cancel` | admin, gerente |
| GET | `/api/recognition/wall` | todos |

Pantallas: `/admin/rh` (Empleados, Asistencia, Nómina, Configuración),
`/admin/rh/nomina/:id` (prenómina y recibos), `/admin/checador`,
`/admin/mi-nomina`, `/admin/empleado-del-mes` (ranking, evaluaciones,
tareas, historial y reglas), `/admin/empleado-del-mes/empleados` (cuando
solo se tiene `empleado_mes`) y `/admin/muro`.

## Domicilios (fase 5)

Todo detrás de `requireModule('domicilios')` (sin el módulo: 402). Dos modos
por restaurante en `delivery_settings.mode`:

- **`propio`**: los repartidores son usuarios del restaurante con rol
  `repartidor`. La caja asigna cada pedido a domicilio y el repartidor lo
  lleva desde su app.
- **`horom`**: la flota de NeuronPOS entrega. Solo se puede elegir si el
  Panel habilitó la flota para ese restaurante (`horom_enabled`); la
  comisión (fija por entrega o porcentaje del subtotal) también la fija el
  Panel. Un trigger (`delivery_settings_guard`) impide que el restaurante
  cambie `horom_enabled` o la comisión aunque escriba directo en la tabla, y
  un `CHECK` impide `mode = 'horom'` sin `horom_enabled`. Al deshabilitarla,
  el Panel regresa el restaurante a `propio`.

**Estados del reparto** (`services/delivery/flow.js`): `asignado →
recogido → en_camino → entregado`, o `fallido` (con motivo obligatorio)
desde `recogido`/`en_camino`; `asignado` se puede cancelar o cambiar de
repartidor. En la flota hay un estado previo `solicitado` (buscando
repartidor). Cualquier otro salto responde `409 INVALID_TRANSITION`. La
orden del POS se sincroniza: `en_camino` la marca como despachada (el
cliente la ve "En camino"), `entregado` registra el cobro y un intento
fallido o cancelado le quita el despacho para reintentar con otro repartidor
o cancelarla. No se puede cancelar una orden con un reparto en curso
(`409 DELIVERY_IN_PROGRESS`).

**Cobro en la puerta** (en centavos):
- Propio: al marcar `entregado`, lo que falta por pagar se registra como un
  pago `efectivo` de la orden con `driver_user_id` (con propina y cambio). Ese
  efectivo no entra a ningún turno de caja hasta el **corte del
  repartidor**: la caja captura lo que entrega, se compara con lo esperado
  (pagos + propinas) y los pagos pasan al turno de caja abierto que se elija,
  así cuadran en el corte de caja. Si la caja cobra la orden antes (el
  cliente pagó en el mostrador), el reparto se marca entregado sin cobro.
- Flota: el repartidor cobra exactamente `cash_to_collect`; el pago
  `efectivo` queda ligado a la solicitud (`delivery_request_id`) y nunca
  entra a una caja del restaurante: ese dinero se lo entrega la plataforma en
  una liquidación.

**Ubicación**: la app del repartidor la manda cada ~20 s mientras está en
turno (`navigator.geolocation`). La caja ve a sus repartidores en un mapa
(Leaflet + OpenStreetMap, por sondeo); el Panel ve a toda la flota. El
cliente, en `/pedido/:token`, ve el estado del reparto y, solo mientras va
`en_camino`, la ubicación **redondeada a 3 decimales** (~100 m) si tiene
menos de 10 minutos; nunca el teléfono del repartidor.

**Flota** (tablas de plataforma): `fleet_drivers` (login propio con
audiencia JWT `fleet`, en `/repartidor` pestaña Flota), `fleet_settings`
(pago general por entrega, oferta automática y su duración),
`delivery_requests` (copia de lo mínimo para entregar: nombre del
restaurante, sucursal, cliente, dirección, total y efectivo a cobrar; el
repartidor nunca lee tablas del restaurante), `delivery_request_offers`,
`fleet_driver_locations`, `fleet_driver_cuts` y `fleet_settlements`.
RLS con un tercer contexto `app.fleet_driver_id` (`withFleetDriver`): un
repartidor de la flota solo ve las solicitudes que tiene asignadas (y las
ofertas que le hicieron); un restaurante solo ve sus solicitudes, y la
ubicación de un repartidor de la flota solo mientras lleva una solicitud
suya. Al pedir repartidor, si `auto_offer` está activo, la solicitud se
ofrece a los repartidores en turno y libres; el primero que acepta se la
lleva. El Panel también asigna, quita, ofrece y cambia estados a mano.

**Comisión y factura**: la comisión se calcula al entregar (las fallidas o
canceladas no cobran) y se cobra **una sola vez**: o se descuenta en una
liquidación o va a la mensualidad. Cada liquidación paga al restaurante el
efectivo que cobró la flota menos las comisiones pendientes que quepan
(nunca un neto negativo); las que no quepan se agregan a la siguiente
factura como la línea `Domicilios Horom (N entregas)` (`code:
domicilios_horom`). Generar la factura otra vez no duplica la línea ni las
entregas (`commission_invoice_id`). Cada repartidor de la flota entrega su
efectivo en un corte por repartidor, y el reporte por periodo da entregas,
fallidas, efectivo, comisiones y lo que se le paga (pago por entrega del
repartidor o el general).

**Tablas del restaurante** (con RLS y llaves compuestas): `order_deliveries`,
`driver_locations`, `driver_cash_cuts`; `order_payments` agrega
`driver_user_id`, `driver_cut_id` y `delivery_request_id`;
`delivery_settings` agrega `horom_enabled`.

| Método | Ruta | Quién |
| --- | --- | --- |
| GET/PUT | `/api/delivery/settings` (PUT `{mode}`; `horom` solo si el Panel la habilitó) | leer: personal; editar: admin |
| GET | `/api/delivery/horom/ledger` (pendiente y liquidaciones de la flota) | admin, gerente |
| GET | `/api/delivery/board?branch_id=` · `/map?branch_id=` | admin, gerente, cajero |
| POST | `/api/delivery/orders/:id/assign` `{driver_user_id}` | ídem (modo propio) |
| POST | `/api/delivery/deliveries/:id/status` `{status, reason?, received?, tip?}` | ídem |
| POST | `/api/delivery/orders/:id/request` `{notes?}` · `/requests/:id/cancel` | ídem (modo horom) |
| GET/POST | `/api/delivery/driver-cuts` (`?branch_id=`; POST `{branch_id, driver_user_id, cash_session_id, counted_cash}`) | ídem |
| GET | `/api/delivery/driver/deliveries` | repartidor |
| POST | `/api/delivery/driver/deliveries/:id/status` · `/driver/duty` · `/driver/location` | repartidor |
| POST | `/api/fleet/auth/login` | repartidor de la flota |
| GET/POST | `/api/fleet/me` · `/duty` · `/location` · `/requests` · `/requests/:id/status` | ídem (token `fleet`) |
| GET/POST | `/api/fleet/offers` · `/offers/:id/accept\|decline` | ídem |
| PUT | `/api/platform/restaurants/:id/delivery` `{horom_enabled, mode, horom_fee_type, horom_fee_value}` | Panel |
| GET/PUT | `/api/platform/fleet/settings` | Panel |
| GET/POST/PATCH | `/api/platform/fleet/drivers[/:id]` | Panel |
| GET/POST | `/api/platform/fleet/drivers/:id/cash` · `/drivers/:id/cuts` | Panel |
| GET | `/api/platform/fleet/requests?status=` · `/fleet/map` | Panel |
| POST | `/api/platform/fleet/requests/:id/assign\|unassign\|offer\|status`; PATCH `/requests/:id` `{commission_amount}` | Panel |
| GET/POST | `/api/platform/fleet/ledger[/:restaurantId]` · `/fleet/settlements` | Panel |
| GET | `/api/platform/fleet/report?from=&to=` | Panel |

Pantallas: `/admin/reparto` (por asignar, en reparto y entregados, mapa y
repartidores; en modo flota, "Pedir repartidor"), `/admin/reparto/cortes`,
`/admin/domicilios` (modo, comisión acordada y liquidaciones de la flota),
`/repartidor` (app móvil: turno, ubicación, Maps/Waze/llamar, cobro en la
puerta, no entregado con motivo; pestañas del restaurante y de la flota),
`/panel/flota` (tablero con mapa, repartidores y su efectivo,
liquidaciones, pagos a repartidores y ajustes), el interruptor de la flota
en el detalle del restaurante del Panel y el estado del reparto con mapa en
`/pedido/:token`.

## Pruebas

```bash
cd backend
npm test                                    # solo unitarias; las de BD se omiten
TEST_DATABASE_URL=postgres://neuron_app:cambiar@localhost:5432/neuronpos_test npm test
```

`TEST_DATABASE_URL` debe apuntar a una base **desechable**: las pruebas borran
y recrean el schema `public`. Usa un rol normal (sin superusuario) dueño de esa
base, para que RLS se pruebe igual que en producción; si el rol se salta RLS,
las pruebas fallan con un aviso.

Qué cubren:
- Aislamiento: un usuario de A no lee, edita ni borra datos de B por la API,
  no puede usar su token en el tenant de B, no asigna sucursales de B, y a
  nivel BD RLS falla cerrado y bloquea inserciones cruzadas.
- `requireModule`: módulo contratado, no contratado, deshabilitado, suspendido
  y prueba vencida.
- Cobro mensual: precio de catálogo, precio especial, descuento, módulos
  vencidos y redondeo en centavos.
- POS (`pos.test.js`, `posMath.test.js`): A no ve, edita, usa ni cobra el
  menú, mesas, órdenes o caja de B (API y RLS); `requireModule('pos')` en
  todas las rutas; totales con modificadores, IVA incluido o encima,
  descuentos por rol; pagos divididos con propina y cambio; flujo de cocina;
  corte de caja (esperado, contado y diferencias).
- Fase 2 (`portal.test.js`, `hours.test.js`): clientes, direcciones,
  pedidos y contenido del sitio no se cruzan entre restaurantes (API y RLS);
  el token de un cliente de A no sirve en B ni en rutas del personal o de la
  plataforma, y los tokens del personal/plataforma no sirven en el portal;
  402 sin `landing`, `portal` o `domicilios`; precios manipulados se ignoran;
  pedidos rechazados con la sucursal cerrada, sin horario, apagados o bajo el
  mínimo; flujo pedido web → aceptar → cocina → lista → reparto → cobro en
  caja; rechazo con motivo; aceptación automática; horarios nocturnos, 24 h,
  días cerrados y zona horaria.
- Fase 3 (`cobro.test.js`, `clip.test.js`, `billing.test.js`), con Clip
  simulado (`clipMock.js`; las pruebas nunca llaman a la API real):
  factura con precio especial y descuento e idempotente; periodos y día de
  cobro; vencida → suspendida tras la gracia → pagar la reactiva; pago
  manual con nota; suspensión manual no se levanta sola; fin de prueba;
  reenviar liga; reconciliador sin webhook; firma de webhook inválida
  rechazada; monto distinto no paga; un webhook de un restaurante o de la
  plataforma no marca pedidos de otro; credenciales cifradas que nunca salen
  por la API; pedido pagado en línea de punta a punta; cancelación por falta
  de pago y pago tardío; pago al recibir sin cambios.
- Fase 4 (`rh.test.js`, `recognition.test.js`, `payrollMath.test.js`,
  `recognitionMath.test.js`): empleados, checadas, justificaciones,
  ajustes, periodos, recibos, firmas, evaluaciones, tareas y resultados no se
  cruzan entre restaurantes (API y RLS en las 19 tablas); 402 sin `rh` o sin
  `empleado_mes`; cálculo de nómina con centavos explícitos (sueldo diario y
  por hora, retardos proporcionales, faltas, horas extra dobles/triples,
  festivos, prima dominical, bonos, préstamos con tope); generar un periodo
  dos veces regresa el mismo y recalcular no duplica; NIP inválido, bloqueo
  tras 5 intentos, sucursal ajena, geocerca, IP y checada duplicada;
  corrección manual con motivo y bitácora; aprobar/reabrir/cerrar y pago
  desde caja; firma del empleado; ranking determinista, cierre idempotente
  (manual y por el job) y premio como bono de nómina.
- Fase 5 (`delivery.test.js`, `deliveryMath.test.js`): 402 sin
  `domicilios`; un repartidor de A no ve pedidos de B, uno de la flota solo
  ve lo asignado y un restaurante no ve solicitudes ni ubicaciones de la
  flota ajenas (API y RLS); transiciones válidas e inválidas; cobro en la
  puerta y corte del repartidor en centavos que cuadra con el corte de caja;
  seguimiento con ubicación aproximada solo en camino; la flota solo si el
  Panel la habilitó (y el restaurante no puede habilitarla ni cambiar la
  comisión ni por SQL); ofertas; comisión fija y porcentual; liquidaciones
  sin neto negativo y la línea de factura idempotente.

Frontend: `npm run lint` y `npm run build` (incluye `tsc`). La fase 5 se
probó además de punta a punta en Chromium (Playwright) con geolocalización
simulada: asignar, app del repartidor, mapa de la caja y del cliente, cobro
en la puerta, corte, y en la flota asignar desde el Panel, entregar,
liquidar, corte del repartidor y reporte.

## Despliegue en el servidor

NeuronPOS Core corre en el mismo servidor que Horom pero totalmente aparte:
base de datos `neuronpos_core` con rol propio, proceso pm2 `neuronpos-core`
en el puerto 8100, carpeta `/opt/neuronpos-core` y su propio bloque de nginx.
No toca nada de Horom.

### 1. DNS de neuronpos.app

Apunta a la IP pública del servidor dos registros A:

| Nombre | Tipo | Valor |
|---|---|---|
| `neuronpos.app` (`@`) | A | IP del servidor |
| `*.neuronpos.app` (`*`) | A | IP del servidor |

`www` queda cubierto por el comodín y nginx lo redirige al dominio raíz.

### 2. Instalación

```bash
sudo git clone https://github.com/horomalimentos/NeuronPOS-Core /opt/neuronpos-core
sudo chown -R "$USER" /opt/neuronpos-core
cd /opt/neuronpos-core && bash deploy/instalar.sh
```

`deploy/instalar.sh` crea el rol `neuron_app` (sin SUPERUSER ni BYPASSRLS) y
la base, genera `backend/.env` con secretos aleatorios (`JWT_SECRET`,
`PAYMENT_SECRETS_KEY`; respáldalos fuera del servidor), corre las
migraciones, compila el frontend y arranca pm2. Se puede volver a correr sin
peligro: no recrea la base ni pisa un `.env` existente.

### 3. Certificado comodín y nginx

Un certificado para `*.neuronpos.app` solo se puede emitir con reto DNS. Lo
más simple es manejar el DNS del dominio en Cloudflare (gratis, registros en
"DNS only") y usar su plugin de certbot:

```bash
sudo apt install python3-certbot-dns-cloudflare
# /root/.secrets/cloudflare.ini con: dns_cloudflare_api_token = <token con permiso DNS:Edit>
sudo chmod 600 /root/.secrets/cloudflare.ini
sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
  -d neuronpos.app -d '*.neuronpos.app'
```

Si el DNS se queda en el proveedor del dominio, se puede emitir a mano con
`certbot certonly --manual --preferred-challenges dns -d neuronpos.app -d '*.neuronpos.app'`,
pero hay que repetir el registro TXT cada 90 días.

Luego:

```bash
sudo cp deploy/neuronpos-app.conf /etc/nginx/snippets/neuronpos-app.conf
sudo cp deploy/nginx-neuronpos.conf /etc/nginx/sites-available/neuronpos
sudo ln -s /etc/nginx/sites-available/neuronpos /etc/nginx/sites-enabled/neuronpos
sudo nginx -t && sudo systemctl reload nginx
```

Los dominios propios de un restaurante (por ejemplo `turestaurante.com`) se
agregan como un bloque más en `nginx-neuronpos.conf` (hay una plantilla
comentada), con su certificado de `certbot --nginx`, y se registran en el
Panel en el campo de dominio propio del restaurante.

### 4. Primer acceso

```bash
cd /opt/neuronpos-core/backend && npm run create-owner -- --email tu@correo.com --name "Alex"
```

El Panel NeuronPOS queda en `https://neuronpos.app/panel`. Cada restaurante
que des de alta vive en `https://<slug>.neuronpos.app`.

### 5. Clip

En `backend/.env` llena `CLIP_API_KEY`, `CLIP_SECRET_KEY` y
`CLIP_WEBHOOK_SECRET` de tu cuenta de Clip, y en el dashboard de Clip
registra el webhook `https://neuronpos.app/api/webhooks/clip/plataforma`.
Después: `pm2 reload neuronpos-core --update-env`. Cada restaurante registra
en su propia cuenta de Clip la URL que le muestra su pantalla de ajustes.

### Actualizar

```bash
cd /opt/neuronpos-core && bash deploy/actualizar.sh
```

Trae `main`, corre migraciones nuevas, compila y recarga pm2. Se detiene si
hay cambios locales sin commit.

## Apps instalables e impresión directa

`apps/desktop` (Windows y Linux) y `apps/android` abren el sistema del
restaurante (`https://<slug>.neuronpos.app/admin/pos`, o `/admin/cocina` en
Neuron KDS) y le dan a la página lo que el navegador no puede: imprimir sin
ventana de impresión y abrir el cajón de dinero. Siempre trabajan en línea.

- **Primera vez:** piden la dirección del restaurante y las impresoras. Se
  vuelve a esa pantalla con el ícono de impresora del encabezado (o Ctrl+, en
  escritorio).
- **Impresoras:** térmicas de 58 u 80 mm por red (IP:9100) o USB. En
  escritorio hay tres tipos: red, "USB directa" (la térmica instalada en
  Windows recibe el ESC/POS en RAW por winspool: corta y abre el cajón) y "con
  el driver de Windows" (impresión silenciosa normal, de respaldo; el cajón se
  abre mandando el pulso en RAW). En Android: red, USB (cable OTG) o
  Bluetooth. Salvo con el driver, el HTML del ticket se dibuja como imagen y
  se manda en ESC/POS (`GS v 0`), así salen acentos y logo sin depender del
  driver.
- **Qué se imprime:** el ticket al cobrar (y el cajón si hubo efectivo), la
  comanda al enviar a cocina desde el POS, y en Neuron KDS la comanda de lo que
  va llegando (incluye pedidos en línea). Los recibos de nómina usan el diálogo
  normal. En el navegador todo sigue como antes.
- **Puente:** `frontend/src/lib/native.ts` (`window.neuronNative` en
  escritorio, `window.NeuronAndroid` en Android). La app solo lo expone a las
  páginas del restaurante configurado.

### Compilar y publicar

```bash
cd /opt/neuronpos-core && bash deploy/instaladores.sh        # todo
bash deploy/instaladores.sh escritorio                         # o solo una parte
bash deploy/instaladores.sh android
```

La versión es `1.0.<número de commits>`. Los archivos quedan en `descargas/`
y el backend los sirve en `/api/descargas` (sin tocar nginx); la página es
https://neuronpos.app/descargas. El escritorio se actualiza solo
(electron-updater); Android avisa cuando hay versión nueva.

Requiere wine para el `.exe`, Java 17 y el SDK de Android. La llave de firma de
Android se crea la primera vez en `/opt/neuronpos-core-secrets` (fuera del
repo): **respáldala**, sin ella no se pueden publicar actualizaciones.

Pruebas de la app de escritorio: `cd apps/desktop && npm test`.

## Siguientes fases

- POS, pendiente: estaciones de cocina e impresión por estación, socket.io
  en lugar de sondeo, mover artículos entre mesas / unir y dividir cuentas por
  artículo, reportes de ventas, inventario y recetas, promociones.
- Domicilios, pendiente: zonas de la flota y costo de envío por distancia,
  volver a ofrecer solas las solicitudes cuya oferta venció (hoy se ofrecen
  al pedirlas y desde el Panel), marcar pagado al repartidor en el reporte,
  socket.io en lugar de sondeo, rutas con varios pedidos y foto/firma de
  entrega.
- Portal, pendiente: programar pedidos para más
  tarde, subir imágenes (hoy son URLs), notificaciones por WhatsApp/correo y
  push en lugar de sondeo, recuperar contraseña, lealtad/puntos.
- Cobro, pendiente: prorrateo al cambiar módulos o día de cobro, facturas
  de periodos pasados, cancelar facturas, reembolsos por API, envío real de
  correos/WhatsApp (hoy el notificador solo escribe en el log), CFDI.
- RH, pendiente: adaptadores de relojes checadores concretos (hay interfaz
  de importación genérica), horarios por fecha (hoy solo semanal), reportes
  de incidencias, puntajes por estación/cocina en el empleado del mes, CFDI
  de nómina, IMSS/ISR y notificaciones en tiempo real.
