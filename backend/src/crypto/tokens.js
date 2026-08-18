import crypto from 'node:crypto';
import config from '../config.js';

/**
 * Google refresh tokens are long-lived credentials for someone's mailbox, so they are
 * encrypted at rest with AES-256-GCM (authenticated: tampering fails decryption rather
 * than silently producing garbage). The key lives in the environment, not the database —
 * a dump of the users table on its own is not enough to use the tokens.
 */
const ALGO = 'aes-256-gcm';

function key() {
  const k = Buffer.from(config.tokenEncryptionKey, 'hex');
  if (k.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)');
  }
  return k;
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(payload) {
  const [iv, tag, data] = String(payload).split(':');
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export default { encrypt, decrypt };
