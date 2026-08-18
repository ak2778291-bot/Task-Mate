import cron from 'node-cron';
import config from '../config.js';
import logger from '../util/logger.js';

/**
 * A cron job polling a table (Section 2). Not a message queue: there is no backpressure
 * problem, no worker fan-out, and no consumer that needs replay here. The Postgres query
 * uses FOR UPDATE SKIP LOCKED, so this stays correct if a second instance is ever started —
 * which is the property that would otherwise push you toward a queue first.
 *
 * The tick is exported separately from the cron wiring so it can be called directly in tests.
 */
export function createScheduler({ repo, executor, log = logger }) {
  let task;
  let running = false;

  async function tick(now = new Date()) {
    if (running) return { skipped: true }; // no overlapping runs
    running = true;
    try {
      const due = await repo.getDueReminders(now);
      for (const reminder of due) {
        await repo.updateReminder(reminder.id, { status: 'fired' });
        log.info('reminder.fired', {
          reminder_id: reminder.id,
          user_id: reminder.user_id,
          message: reminder.payload?.message,
        });
      }

      // Anything still 'executing' is a workflow whose process died mid-run.
      const resumed = await executor.resumeInterrupted();

      return { fired: due.length, resumed: resumed.length };
    } catch (err) {
      log.error('scheduler.tick_failed', { error: err.message });
      return { error: err.message };
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (!config.schedulerEnabled) {
        log.info('scheduler.disabled', {});
        return;
      }
      task = cron.schedule(config.schedulerCron, () => tick());
      log.info('scheduler.started', { cron: config.schedulerCron });
    },
    stop() {
      task?.stop();
    },
  };
}

export default createScheduler;
