import jwt from 'jsonwebtoken';
import config from '../config.js';
import { AppError } from '../util/errors.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new AppError('Missing bearer token', { code: 'UNAUTHENTICATED', status: 401 }));
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return next(new AppError('Invalid or expired token', { code: 'UNAUTHENTICATED', status: 401 }));
  }
}

export default requireAuth;
