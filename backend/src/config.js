import 'dotenv/config';

const bool = (v, dflt = false) =>
  v === undefined ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://ows:ows@localhost:5432/ows',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  // 32-byte hex key for AES-256-GCM encryption of Google refresh tokens at rest.
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '0'.repeat(64),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/auth/google/callback',
    // Least privilege (Section 2): send-only Gmail + Calendar events. No full-mailbox read,
    // no Drive, no Tasks. gmail.send cannot read the inbox; gmail.metadata is needed only so
    // the crash-reconciliation lookup in tools/gmail.js can find a message by its Message-ID.
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  },

  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.LLM_MODEL || 'claude-sonnet-5',
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 2000),
  },

  // When true, the tool layer talks to an in-process fake Google that reproduces the two
  // real behaviours we depend on (Message-ID lookup, client-assigned event IDs).
  // Lets the whole system be demoed and tested without OAuth credentials.
  mockGoogle: bool(process.env.MOCK_GOOGLE, !process.env.GOOGLE_CLIENT_ID),
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),
  schedulerCron: process.env.SCHEDULER_CRON || '* * * * *',
};

export default config;
