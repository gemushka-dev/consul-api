import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../../config/db.js';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import { users, type UserRow } from '../../db/schema.js';
import type { AccessTokenPayload, RefreshTokenPayload } from '../../middlewares/auth.js';
import type { SupportedLang, UserRole } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';

const OTP_TTL_SECONDS = 5 * 60; // 5 minutes
const OTP_LOCK_SECONDS = 10 * 60; // 10 minutes
const OTP_MAX_ATTEMPTS = 3;
const ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function serializeUser(user: UserRow) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    lang: user.lang as SupportedLang,
    role: user.role as UserRole,
    consent_at: user.consentAt ? user.consentAt.toISOString() : null,
    consent_version: user.consentVersion,
    stats_consent_at: user.statsConsentAt ? user.statsConsentAt.toISOString() : null,
    prefs: user.prefs ?? {},
    created_at: user.createdAt.toISOString(),
  };
}

export function issueAuthTokens(user: UserRow): {
  accessToken: string;
  refreshToken: string;
  jti: string;
} {
  const accessPayload: AccessTokenPayload = {
    sub: user.id,
    role: user.role as UserRole,
    lang: user.lang as SupportedLang,
    type: 'access',
  };

  const jti = crypto.randomUUID();
  const refreshPayload: RefreshTokenPayload = {
    sub: user.id,
    role: user.role as UserRole,
    jti,
    type: 'refresh',
  };

  const accessToken = jwt.sign(accessPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: ACCESS_TTL_SECONDS,
  });
  const refreshToken = jwt.sign(refreshPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TTL_SECONDS,
  });

  return { accessToken, refreshToken, jti };
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const secure = env.NODE_ENV === 'production';
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: ACCESS_TTL_SECONDS * 1000,
    path: '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: REFRESH_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function clearAuthCookies(res: Response): void {
  const secure = env.NODE_ENV === 'production';
  res.clearCookie('access_token', { httpOnly: true, secure, sameSite: 'strict', path: '/' });
  res.clearCookie('refresh_token', { httpOnly: true, secure, sameSite: 'strict', path: '/' });
}

export async function sendOtp(phone: string, clientIp: string): Promise<void> {
  const [phoneLimit, ipLimit] = await Promise.all([
    redis.limitOtp(`phone:${phone}`),
    redis.limitOtp(`ip:${clientIp}`),
  ]);

  if (!phoneLimit.success || !ipLimit.success) {
    throw Errors.tooManyRequests('otp_rate_limited', 'Too many OTP requests. Try again in 10 minutes.');
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await redis.set(`otp:${phone}`, sha256(code), { ex: OTP_TTL_SECONDS });
  await redis.del(`otp:attempts:${phone}`);

  // In production this invokes an SMS gateway (e.g. Eskiz.uz); never log OTP in prod.
  if (env.NODE_ENV === 'development') {
    console.log(`[auth:otp] generated OTP for ${phone}`);
  }
}

export async function verifyOtp(
  phone: string,
  code: string,
): Promise<{ user: UserRow; isNew: boolean }> {
  const lockKey = `otp:lock:${phone}`;
  const locked = await redis.get<string>(lockKey);
  if (locked) {
    throw Errors.tooManyRequests(
      'otp_locked',
      'Too many failed attempts. Please wait 10 minutes before trying again.',
    );
  }

  const storedHash = await redis.get<string>(`otp:${phone}`);
  const isDemoBypass = env.APP_ENV === 'demo' && code === env.DEMO_OTP;
  const codeMatches = Boolean(storedHash && storedHash === sha256(code));

  if (!codeMatches && !isDemoBypass) {
    const attemptsKey = `otp:attempts:${phone}`;
    const attempts = await redis.incr(attemptsKey);
    await redis.expire(attemptsKey, OTP_LOCK_SECONDS);

    if (attempts >= OTP_MAX_ATTEMPTS) {
      await redis.set(lockKey, '1', { ex: OTP_LOCK_SECONDS });
      await redis.del(`otp:${phone}`);
      throw Errors.tooManyRequests(
        'otp_locked',
        'Maximum OTP attempts exceeded. Account verification locked for 10 minutes.',
      );
    }

    throw Errors.unauthorized('invalid_otp', 'Invalid or expired OTP code');
  }

  await Promise.all([redis.del(`otp:${phone}`), redis.del(`otp:attempts:${phone}`)]);

  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (existing[0]) {
    return { user: existing[0], isNew: false };
  }

  const inserted = await db
    .insert(users)
    .values({
      phone,
      lang: 'uz',
      role: 'user',
    })
    .returning();

  const created = inserted[0];
  if (!created) {
    throw new Error('Failed to create user');
  }
  return { user: created, isNew: true };
}

export async function registerLegacy(email: string, password: string, lang: SupportedLang) {
  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) {
    throw Errors.conflict('email_taken', 'An account with this email already exists', 'email');
  }

  const inserted = await db
    .insert(users)
    .values({
      email,
      passwordHash: hashPassword(password),
      lang,
      role: 'user',
    })
    .returning();

  const created = inserted[0];
  if (!created) {
    throw new Error('Failed to register user');
  }
  return created;
}

export async function loginLegacy(email: string, password: string) {
  const db = getDb();
  const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = found[0];
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw Errors.unauthorized('invalid_credentials', 'Invalid email or password');
  }
  return user;
}

export async function blacklistRefreshToken(refreshToken: string): Promise<RefreshTokenPayload | null> {
  try {
    const payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
    if (payload.type !== 'refresh' || !payload.jti) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, (payload.exp ?? nowSec + REFRESH_TTL_SECONDS) - nowSec);
    await redis.set(`bl:refresh:${payload.jti}`, '1', { ex: ttl });
    return payload;
  } catch {
    return null;
  }
}

export async function rotateRefreshToken(refreshToken: string): Promise<UserRow> {
  let payload: RefreshTokenPayload;
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  } catch {
    throw Errors.unauthorized('invalid_refresh_token', 'Invalid or expired refresh token');
  }

  if (payload.type !== 'refresh' || !payload.jti || !payload.sub) {
    throw Errors.unauthorized('invalid_refresh_token', 'Invalid refresh token payload');
  }

  const blacklisted = await redis.get<string>(`bl:refresh:${payload.jti}`);
  if (blacklisted) {
    throw Errors.unauthorized('token_revoked', 'Refresh token has been revoked');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, (payload.exp ?? nowSec + REFRESH_TTL_SECONDS) - nowSec);
  await redis.set(`bl:refresh:${payload.jti}`, '1', { ex: ttl });

  const db = getDb();
  const found = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!found[0]) {
    throw Errors.unauthorized('user_not_found', 'User no longer exists');
  }
  return found[0];
}
