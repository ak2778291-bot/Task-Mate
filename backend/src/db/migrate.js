import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPool, closePool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await getPool().query(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => console.log('migrations applied'))
    .catch((err) => {
      console.error('migration failed:', err.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}
