import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { SupportedLang, UserRole } from '../types/express.d.js';
import { Errors } from '../utils/errors.js';
import { resolveLang } from './lang.js';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  lang?: SupportedLang;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  role: UserRole;
  jti: string;
  type: 'refresh';
  exp?: number;
}

function extractAccessToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const cookieToken = req.cookies?.access_token;
  if (typeof cookieToken === 'string' && cookieToken.length > 0) {
    return cookieToken;
  }
  return null;
}

function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    if (payload.type !== 'access' || !payload.sub) {
      throw Errors.unauthorized('invalid_token', 'Invalid access token');
    }
    return payload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw Errors.unauthorized('token_expired', 'Access token expired');
    }
    throw Errors.unauthorized('invalid_token', 'Invalid access token');
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractAccessToken(req);
  if (!token) {
    next(Errors.unauthorized('unauthorized', 'Authentication required'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      lang: payload.lang,
    };
    req.lang = resolveLang(req, payload.lang);
    next();
  } catch (err) {
    next(err);
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractAccessToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      lang: payload.lang,
    };
    req.lang = resolveLang(req, payload.lang);
  } catch {
    // Ignore invalid optional tokens
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(Errors.unauthorized('unauthorized', 'Authentication required'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(Errors.forbidden('forbidden', 'Insufficient role permissions'));
      return;
    }
    next();
  };
}
