// Utilidades para pruebas de integracion contra Postgres real.
//
// Se activan con TEST_DATABASE_URL (una BD desechable: se borra el schema
// public completo). El usuario debe ser un rol normal (sin SUPERUSER ni
// BYPASSRLS), duenio de la BD, para que RLS aplique igual que en produccion.
// Sin TEST_DATABASE_URL las pruebas de BD se marcan como "skipped".
import http from 'node:http';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const SKIP_DB = TEST_DB_URL
  ? false
  : 'TEST_DATABASE_URL no esta definida: se omiten las pruebas con base de datos';

export const PLATFORM_DOMAIN = 'neuronpos.test';

/** Configura el entorno, reinicia la BD, migra y levanta la app en un puerto libre. */
export async function setupDb() {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    JWT_SECRET: 'secreto-de-pruebas',
    PLATFORM_DOMAIN,
    ALLOW_SLUG_HEADER: 'true',
    // Fase 3: cuenta de Clip de la plataforma (simulada) y llave de cifrado.
    CLIP_API_KEY: 'plataforma-api-key',
    CLIP_SECRET_KEY: 'plataforma-secret-key',
    CLIP_WEBHOOK_SECRET: 'plataforma-webhook-secret',
    PAYMENT_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_API_URL: 'https://api.neuronpos.test',
    JOBS_ENABLED: 'false',
  });
  const db = await import('../config/database.js');
  const { runMigrations } = await import('../scripts/migrate.js');
  const { createApp } = await import('../app.js');

  const role = await db.checkDbRole();
  if (role.bypassesRls) {
    throw new Error(`El rol de pruebas "${role.user}" se salta RLS (superuser/BYPASSRLS); usa un rol normal`);
  }

  await db.default.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.default.query('CREATE SCHEMA public');
  await runMigrations(db.default, { log: () => {} });

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();

  const ctx = {
    pool: db.default,
    withTenant: db.withTenant,
    withPlatform: db.withPlatform,
    port,
    async close() {
      await new Promise((r) => server.close(r));
      await db.default.end();
    },
    /** request HTTP con control total de headers (incluido Host). */
    request(method, path, { body, token, slug, host, headers = {} } = {}) {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const h = { ...headers };
        if (payload) {
          h['content-type'] = 'application/json';
          // Node no usa chunked en DELETE: sin content-length el cuerpo se pierde.
          h['content-length'] = Buffer.byteLength(payload);
        }
        if (token) h.authorization = `Bearer ${token}`;
        if (slug) h['x-restaurant-slug'] = slug;
        if (host) h.host = host;
        const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let json = null;
            try { json = data ? JSON.parse(data) : null; } catch { json = data; }
            resolve({ status: res.statusCode, body: json });
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
  return ctx;
}

/** Crea un dueno de plataforma y regresa su token. */
export async function ownerToken(ctx, email = 'alex@neuronpos.test', password = 'secreto-123') {
  const bcrypt = (await import('bcryptjs')).default;
  await ctx.pool.query(
    `INSERT INTO platform_admins (email, name, password_hash) VALUES ($1, 'Alex', $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, await bcrypt.hash(password, 4)],
  );
  const res = await ctx.request('POST', '/api/platform/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login de dueno fallo: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/** Crea un restaurante con admin via la API de plataforma y hace login como ese admin. */
export async function createRestaurant(ctx, owner, slug, { modules = [], status = 'active' } = {}) {
  const email = `admin@${slug}.test`;
  const password = 'clave-segura-1';
  const res = await ctx.request('POST', '/api/platform/restaurants', {
    token: owner,
    body: { slug, name: `Restaurante ${slug.toUpperCase()}`, status, modules, admin: { email, name: `Admin ${slug}`, password } },
  });
  if (res.status !== 201) throw new Error(`crear restaurante fallo: ${JSON.stringify(res.body)}`);
  const login = await ctx.request('POST', '/api/auth/login', { slug, body: { email, password } });
  if (login.status !== 200) throw new Error(`login fallo: ${JSON.stringify(login.body)}`);
  return { id: res.body.restaurant.id, slug, email, password, token: login.body.token, detail: res.body };
}
