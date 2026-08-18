export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 400, details } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Thrown when a proposed action is not in the granted permission set. */
export class PermissionError extends AppError {
  constructor(message, details) {
    super(message, { code: 'PERMISSION_DENIED', status: 403, details });
  }
}

/** Thrown when a proposed action's arguments do not match the tool's schema. */
export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { code: 'VALIDATION_FAILED', status: 422, details });
  }
}

/** Transient upstream failure — safe to retry with backoff. */
export class TransientError extends AppError {
  constructor(message, details) {
    super(message, { code: 'TRANSIENT', status: 503, details });
    this.transient = true;
  }
}

/** Google/HTTP status codes and socket errors that are worth retrying. */
export function isTransient(err) {
  if (err?.transient) return true;
  const status = err?.status ?? err?.code;
  if ([429, 500, 502, 503, 504].includes(Number(status))) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(err?.code);
}
