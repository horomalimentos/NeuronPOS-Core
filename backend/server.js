import { createApp } from './app.js';
import { checkDbRole } from './config/database.js';
import { env } from './config/env.js';
import { startJobs } from './services/jobs.js';

async function main() {
  try {
    const role = await checkDbRole();
    if (role.bypassesRls) {
      const msg = `El usuario de BD "${role.user}" es SUPERUSER o tiene BYPASSRLS: las politicas RLS no lo protegen.`;
      if (process.env.REQUIRE_RLS_ROLE === 'true' || env.isProduction) {
        console.error(`${msg} Usa un rol normal (ver README).`);
        process.exit(1);
      }
      console.warn(`ADVERTENCIA: ${msg}`);
    }
  } catch (err) {
    console.warn('No se pudo verificar el rol de la base de datos:', err.message);
  }

  const app = createApp();
  app.listen(env.port, () => {
    console.log(`NeuronPOS Core backend escuchando en http://localhost:${env.port}`);
  });
  startJobs();
}

main();
