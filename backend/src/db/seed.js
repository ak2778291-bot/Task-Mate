import bcrypt from 'bcryptjs';
import { createPgRepository } from './repository.pg.js';
import { closePool } from './pool.js';
import { migrate } from './migrate.js';

/**
 * Creates the demo account and re-asserts the permission grants.
 *
 * Note what is NOT granted: gmail.delete_email is implemented in the tool registry but
 * appears in no grant here. That gap is the fixture the permission tests fire against —
 * a real registered action that the system will still refuse to run.
 */
const DEMO = { email: 'demo@one-work-space.local', password: 'demo-password-123' };

async function seed() {
  await migrate();
  const repo = createPgRepository();

  const existing = await repo.findUserByEmail(DEMO.email);
  if (!existing) {
    await repo.createUser({ email: DEMO.email, passwordHash: await bcrypt.hash(DEMO.password, 10) });
    console.log(`seeded user ${DEMO.email} / ${DEMO.password}`);
  } else {
    console.log(`user ${DEMO.email} already exists`);
  }

  await repo.setToolPermission('gmail', ['send_email', 'create_draft']);
  await repo.setToolPermission('calendar', ['create_event', 'list_events']);
  await repo.setToolPermission('reminders', ['create_reminder', 'cancel_reminder']);
  console.log('tool permissions applied (gmail.delete_email deliberately ungranted)');
}

seed()
  .catch((err) => {
    console.error('seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
