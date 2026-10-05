#!/usr/bin/env node
// Crea (o actualiza la contrasena de) una cuenta de dueno de la plataforma.
//
//   npm run create-owner -- --email alex@ejemplo.com --name "Alex"
//
// La contrasena se pide por consola; para automatizar se puede pasar en la
// variable OWNER_PASSWORD.
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import bcrypt from 'bcryptjs';
import pool from '../config/database.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else rl.output.write('*');
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const email = values.email || (await ask('Correo: '));
  const name = values.name || (await ask('Nombre: '));
  const password = process.env.OWNER_PASSWORD || (await ask('Contrasena (min. 8): ', { hidden: true }));

  if (!email || !name) throw new Error('Correo y nombre son obligatorios');
  if (!password || password.length < 8) throw new Error('La contrasena debe tener al menos 8 caracteres');

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO platform_admins (email, name, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
           active = true, updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [email, name, hash],
  );
  console.log(rows[0].created ? `Dueno creado: ${email}` : `Dueno actualizado: ${email}`);
}

main()
  .catch((err) => {
    console.error('Error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
