/**
 * Structured logging (Section 3: this is the whole observability story at this scale).
 * One JSON object per line so a hosted log viewer can filter on workflow_id / step_id.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
  child(base) {
    return {
      debug: (m, f) => emit('debug', m, { ...base, ...f }),
      info: (m, f) => emit('info', m, { ...base, ...f }),
      warn: (m, f) => emit('warn', m, { ...base, ...f }),
      error: (m, f) => emit('error', m, { ...base, ...f }),
      child: (more) => logger.child({ ...base, ...more }),
    };
  },
};

export default logger;
