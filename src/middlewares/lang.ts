import type { NextFunction, Request, Response } from 'express';
import type { SupportedLang } from '../types/express.d.js';

const SUPPORTED: readonly SupportedLang[] = ['uz', 'ru', 'en'];

export function normalizeLang(raw: unknown): SupportedLang | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase().slice(0, 2);
  return (SUPPORTED as readonly string[]).includes(cleaned)
    ? (cleaned as SupportedLang)
    : null;
}

/**
 * Resolves response language by priority:
 * 1. ?lang= query param
 * 2. user.lang from profile (when attached by auth middleware)
 * 3. Accept-Language header
 * 4. default 'uz'
 */
export function resolveLang(req: Request, userLang?: string | null): SupportedLang {
  const queryLang = normalizeLang(req.query.lang);
  if (queryLang) return queryLang;

  const profileLang = normalizeLang(userLang ?? req.user?.lang);
  if (profileLang) return profileLang;

  const header = req.headers['accept-language'];
  if (typeof header === 'string') {
    const parts = header.split(',');
    for (const part of parts) {
      const code = normalizeLang(part.split(';')[0]);
      if (code) return code;
    }
  }

  return 'uz';
}

export function langMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.lang = resolveLang(req);
  next();
}
