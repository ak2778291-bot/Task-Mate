import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import config from '../config.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { encrypt } from '../crypto/tokens.js';
import { authUrl, makeOAuthClient } from '../tools/google-client.js';
import { AppError } from '../util/errors.js';
import logger from '../util/logger.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'password must be at least 8 characters'),
});

export function authRoutes({ repo }) {
  const router = Router();

  router.post('/register', async (req, res, next) => {
    try {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('Invalid email or password', {
          code: 'VALIDATION_FAILED',
          status: 422,
          details: parsed.error.issues.map((i) => i.message),
        });
      }
      const passwordHash = await bcrypt.hash(parsed.data.password, 10);
      const user = await repo.createUser({ email: parsed.data.email, passwordHash });
      res.status(201).json({ token: signToken(user), user: { id: user.id, email: user.email } });
    } catch (err) {
      if (err.code === 'EMAIL_TAKEN') {
        return next(new AppError('That email is already registered', { code: 'EMAIL_TAKEN', status: 409 }));
      }
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success) throw new AppError('Invalid email or password', { status: 401, code: 'UNAUTHENTICATED' });
      const user = await repo.findUserByEmail(parsed.data.email);
      // Same message and roughly the same work either way — no user enumeration.
      const ok = user && (await bcrypt.compare(parsed.data.password, user.password_hash));
      if (!ok) throw new AppError('Email or password is incorrect', { status: 401, code: 'UNAUTHENTICATED' });
      res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth, async (req, res, next) => {
    try {
      const user = await repo.findUserById(req.user.id);
      if (!user) throw new AppError('User not found', { status: 404, code: 'NOT_FOUND' });
      res.json({
        id: user.id,
        email: user.email,
        google_connected: !!user.google_refresh_token_encrypted || config.mockGoogle,
        google_mode: config.mockGoogle ? 'mock' : 'live',
      });
    } catch (err) {
      next(err);
    }
  });

  // Start the consent flow. The JWT rides in `state` so the callback knows who came back;
  // Google will only redirect to the registered redirect URI, so it cannot be pointed elsewhere.
  router.get('/google', requireAuth, (req, res) => {
    res.json({ url: authUrl(signToken(req.user)) });
  });

  router.get('/google/callback', async (req, res, next) => {
    try {
      const { code, state, error } = req.query;
      if (error) throw new AppError(`Google returned: ${error}`, { code: 'OAUTH_FAILED', status: 400 });
      if (!code || !state) throw new AppError('Missing code or state', { code: 'OAUTH_FAILED', status: 400 });

      const jwtLib = (await import('jsonwebtoken')).default;
      const payload = jwtLib.verify(String(state), config.jwtSecret);

      const client = makeOAuthClient();
      const { tokens } = await client.getToken(String(code));
      if (!tokens.refresh_token) {
        throw new AppError(
          'Google did not return a refresh token. Revoke prior access and connect again.',
          { code: 'OAUTH_NO_REFRESH_TOKEN', status: 400 },
        );
      }
      await repo.setGoogleRefreshToken(payload.sub, encrypt(tokens.refresh_token));
      logger.info('google.connected', { user_id: payload.sub });
      res.redirect(`${config.corsOrigin}/?google=connected`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default authRoutes;
