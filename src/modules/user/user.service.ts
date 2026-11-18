import { eq } from 'drizzle-orm';
import { getDb } from '../../config/db.js';
import {
  businesses,
  businessStatusHistory,
  users,
  type BusinessRow,
  type UserPrefs,
} from '../../db/schema.js';
import { Errors } from '../../utils/errors.js';
import { toSafeInt } from '../../utils/money.js';
import { serializeUser } from '../auth/auth.service.js';

export function serializeBusiness(biz: BusinessRow | null) {
  if (!biz) return null;
  return {
    trade: biz.trade,
    sector: biz.sector,
    market: biz.market,
    status: biz.status,
    regime: biz.regime,
    reserve: toSafeInt(biz.reserve),
    updated_at: biz.updatedAt.toISOString(),
  };
}

export async function getUserProfile(userId: string) {
  const db = getDb();
  const [userRows, bizRows] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1),
  ]);

  const user = userRows[0];
  if (!user) {
    throw Errors.notFound('user_not_found', 'User not found');
  }

  return {
    user: serializeUser(user),
    business: serializeBusiness(bizRows[0] ?? null),
  };
}

export async function updateUserProfile(
  userId: string,
  patch: { lang?: 'uz' | 'ru' | 'en'; prefs?: UserPrefs },
) {
  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const current = existing[0];
  if (!current) {
    throw Errors.notFound('user_not_found', 'User not found');
  }

  const mergedPrefs: UserPrefs = {
    ...(current.prefs ?? {}),
    ...(patch.prefs ?? {}),
  };

  const updated = await db
    .update(users)
    .set({
      ...(patch.lang ? { lang: patch.lang } : {}),
      prefs: mergedPrefs,
    })
    .where(eq(users.id, userId))
    .returning();

  const bizRows = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);

  return {
    user: serializeUser(updated[0]!),
    business: serializeBusiness(bizRows[0] ?? null),
  };
}

export async function upsertBusinessProfile(
  userId: string,
  input: {
    trade: string;
    sector: string;
    market: string;
    status: string;
    regime: string;
    reserve: number;
  },
) {
  const db = getDb();
  const existing = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);
  const prev = existing[0] ?? null;

  let saved: BusinessRow;
  if (!prev) {
    const inserted = await db
      .insert(businesses)
      .values({
        userId,
        trade: input.trade,
        sector: input.sector,
        market: input.market,
        status: input.status,
        regime: input.regime,
        reserve: input.reserve,
        updatedAt: new Date(),
      })
      .returning();
    saved = inserted[0]!;

    await db.insert(businessStatusHistory).values({
      userId,
      oldStatus: null,
      newStatus: input.status,
    });
  } else {
    const updated = await db
      .update(businesses)
      .set({
        trade: input.trade,
        sector: input.sector,
        market: input.market,
        status: input.status,
        regime: input.regime,
        reserve: input.reserve,
        updatedAt: new Date(),
      })
      .where(eq(businesses.userId, userId))
      .returning();
    saved = updated[0]!;

    if (prev.status !== input.status) {
      await db.insert(businessStatusHistory).values({
        userId,
        oldStatus: prev.status,
        newStatus: input.status,
      });
    }
  }

  return serializeBusiness(saved);
}

export async function setPersonalDataConsent(userId: string, granted: boolean, version = '2026-v1') {
  const db = getDb();
  const updated = await db
    .update(users)
    .set({
      consentAt: granted ? new Date() : null,
      consentVersion: granted ? version : null,
    })
    .where(eq(users.id, userId))
    .returning();

  if (!updated[0]) {
    throw Errors.notFound('user_not_found', 'User not found');
  }
  return serializeUser(updated[0]);
}

export async function setStatsConsent(userId: string, granted: boolean) {
  const db = getDb();
  const updated = await db
    .update(users)
    .set({
      statsConsentAt: granted ? new Date() : null,
    })
    .where(eq(users.id, userId))
    .returning();

  if (!updated[0]) {
    throw Errors.notFound('user_not_found', 'User not found');
  }
  return serializeUser(updated[0]);
}

export async function deleteUserAccount(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(users).where(eq(users.id, userId));
}
