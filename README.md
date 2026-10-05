# NeuronPOS Core

Plataforma SaaS multi-restaurante de NeuronPOS. Cada restaurante se suscribe
mensualmente a los módulos que usa (POS, sitio web, portal de clientes,
recursos humanos, empleado del mes, domicilios) y el dueño de la plataforma
configura el precio de cada módulo.

Este repo es independiente del NeuronPOS de Horom Sushi: base de datos propia,
proceso pm2 propio y dominio propio. Usa el mismo stack (React + Vite +
TypeScript + Tailwind, Express ESM + `pg`, Postgres).

> **Estado: Fase 1a (cimientos).** Ya están el esquema multi-restaurante, la
> resolución del restaurante, la autenticación, el control de módulos, el Panel
> NeuronPOS y la administración básica del restaurante (sucursales y usuarios).
> El POS, el menú y las órdenes se portan en la siguiente fase.

## Estructura

```
backend/            API Express (ESM) + pg
  app.js            arma la app (server.js la levanta, las pruebas la importan)
  config/           variables de entorno y pool de Postgres (withTenant / withPlatform)
  middleware/       tenant.js, auth.js, requireModule.js
  routes/           platform.js (Panel), auth, me, branches, users, public, pos
  services/         billing.js (cobro mensual), access.js (reglas 402), restaurants.js
  scripts/          migrate.js, create-owner.js
  tests/            node:test (unitarias + integración con Postgres)
db/migrations/      SQL numerado (001_, 002_, ...), se aplica con npm run migrate
frontend/           React 18 + Vite + TS + Tailwind
  src/platform/     Panel NeuronPOS (dueño de la plataforma)
  src/restaurant/   Administración del restaurante
  src/site/         Vista pública del sitio (provisional)
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
| `LOGIN_RATE_LIMIT` | Intentos de login por IP cada 15 min | `20` |
| `PLATFORM_DOMAIN` | Dominio base; los restaurantes viven en `<slug>.<dominio>` | `localhost` |
| `RESERVED_SUBDOMAINS` | Subdominios que nunca son restaurantes | `www,app,api,admin,panel,static,cdn,mail` |
| `ALLOW_SLUG_HEADER` | Acepta el header `X-Restaurant-Slug` | `true` fuera de producción |
| `TRIAL_DAYS` | Días de prueba al crear un restaurante en `trial` | `14` |
| `CORS_ORIGINS` | Orígenes permitidos separados por coma | en dev, cualquiera |

## Aislamiento entre restaurantes

Una sola base de datos compartida. Toda tabla que pertenece a un restaurante
tiene `restaurant_id` (`restaurant_modules`, `delivery_settings`, `branches`,
`users`, `user_branches`, `subscription_invoices`). La protección tiene tres
capas:

1. **Resolución del restaurante** (`middleware/tenant.js`), en este orden:
   - `Host`: `<slug>.<PLATFORM_DOMAIN>` o el `custom_domain` del restaurante.
   - Header `X-Restaurant-Slug` (solo si `ALLOW_SLUG_HEADER`, y solo si el
     Host no apunta a un restaurante).
   - Claim `rid` del JWT.

   El JWT de un usuario lleva el `restaurant_id`; si el restaurante resuelto
   por Host/header no coincide, la API responde `403 TENANT_MISMATCH`. Los
   tokens de usuario (`typ: user`) y de plataforma (`typ: platform`) no son
   intercambiables.

2. **Consultas con filtro explícito**: cada consulta de las rutas del
   restaurante filtra por `restaurant_id = req.tenant.id`.

3. **Row Level Security en Postgres** (`db/migrations/003_rls.sql`), como red
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

`subscription_invoices` queda listo para la facturación, sin proveedor de
pagos todavía.

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
| GET | `/api/public/site` | Público: marca, módulos habilitados y sucursales |
| GET | `/api/pos/status` | Marcador protegido con `requireModule('pos')` |
| GET | `/api/health` | Estado del servidor y la BD |

Roles de usuario: `admin`, `gerente`, `cajero`, `mesero`, `cocina`,
`repartidor`. Los `admin` tienen acceso a todas las sucursales; el resto, a
las de `user_branches` (la primera es la principal).

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

Frontend: `npm run lint` y `npm run build` (incluye `tsc`).

## Producción (resumen)

- Base de datos propia (`neuronpos_core`) con rol propio, aunque comparta
  servidor con Horom.
- `NODE_ENV=production`, `JWT_SECRET` largo, `PLATFORM_DOMAIN` real,
  `ALLOW_SLUG_HEADER=false` si todo se sirve por subdominio.
- Backend con pm2: `pm2 start backend/ecosystem.config.cjs --env production`
  (proceso `neuronpos-core`).
- nginx: certificado comodín para `*.<PLATFORM_DOMAIN>`, servir
  `frontend/dist` y mandar `/api` al backend conservando `Host`
  (`proxy_set_header Host $host;`). Los dominios propios de cada restaurante
  se agregan como `server_name` adicionales apuntando a lo mismo.

## Siguientes fases

- Portar el POS (menú, órdenes, caja) de NeuronPOS sobre `withTenant`.
- Sitio web y portal de clientes por restaurante.
- Facturación automática con proveedor de pagos.
