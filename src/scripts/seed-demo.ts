import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/db.js';
import {
  businesses,
  businessStatusHistory,
  chats,
  counterparties,
  memoryFacts,
  obligations,
  ops,
  users,
  type UserRow,
} from '../db/schema.js';
import {
  addDays,
  getTashkentParts,
  startOfTashkentMonth,
  toTashkentDateString,
} from '../utils/time.js';

export const DEMO_PHONE = '+998901234567';
export const DEMO_EMAIL = 'dilnoza@consul.uz';

/**
 * Resets and seeds the reference Dilnoza demo account:
 * - cash = 12,000,000 (naqd = 4,800,000, karta = 7,200,000)
 * - current month sales = 50,000,000 => tax (1%) = 500,000
 * - upcoming obligations = rent 3,000,000 + supplier 3,100,000 + tax 500,000 = 6,600,000
 * - reserve = 1,200,000
 * - free = 4,200,000
 * - profit_3m = 6,000,000
 */
export async function seedDemoUser(now: Date = new Date()): Promise<UserRow> {
  const db = getDb();

  // Remove existing demo user if present (cascades all related records)
  const existing = await db.select().from(users).where(eq(users.phone, DEMO_PHONE)).limit(1);
  if (existing[0]) {
    await db.delete(users).where(eq(users.id, existing[0].id));
  }

  const [user] = await db
    .insert(users)
    .values({
      phone: DEMO_PHONE,
      email: DEMO_EMAIL,
      lang: 'uz',
      role: 'user',
      consentAt: now,
      consentVersion: '2026-v1',
      statsConsentAt: now,
      prefs: {
        largeFont: false,
        voiceReply: true,
        voiceSpeed: 1.0,
      },
    })
    .returning();

  const userId = user!.id;

  await db.insert(businesses).values({
    userId,
    trade: 'Quritilgan mevalar va yong‘oqlar (Dilnoza)',
    sector: 'dried_fruit',
    market: 'chorsu',
    status: 'yatt',
    regime: 'turnover',
    reserve: 1_200_000,
    updatedAt: now,
  });

  await db.insert(businessStatusHistory).values({
    userId,
    oldStatus: 'none',
    newStatus: 'yatt',
    changedAt: startOfTashkentMonth(now, -2),
  });

  const insertedCps = await db
    .insert(counterparties)
    .values([
      { userId, name: 'Akmal', kind: 'customer', phone: '+998901112233' },
      { userId, name: 'Sardor', kind: 'customer', phone: '+998904445566' },
      { userId, name: 'Samarqand Mayiz Opt', kind: 'supplier', phone: '+998917778899' },
    ])
    .returning();

  const akmal = insertedCps.find((c) => c.name === 'Akmal')!;
  const sardor = insertedCps.find((c) => c.name === 'Sardor')!;
  const supplier = insertedCps.find((c) => c.kind === 'supplier')!;

  const m3 = startOfTashkentMonth(now, -3);
  const m2 = startOfTashkentMonth(now, -2);
  const m1 = startOfTashkentMonth(now, -1);
  const m0 = startOfTashkentMonth(now, 0);

  await db.insert(ops).values([
    // Month -3 (net profit = 6,000,000; naqd +2M, karta +4M)
    { userId, kind: 'sale', amount: 22_000_000, method: 'naqd', label: 'Savdo (naqd)', fiscal: false, source: 'seed', occurredAt: addDays(m3, 5) },
    { userId, kind: 'sale', amount: 24_000_000, method: 'karta', label: 'Savdo (terminal)', fiscal: true, source: 'seed', occurredAt: addDays(m3, 12) },
    { userId, kind: 'buy', amount: 17_000_000, method: 'naqd', label: 'Mayiz va bodom xaridi', fiscal: false, source: 'seed', occurredAt: addDays(m3, 6) },
    { userId, kind: 'buy', amount: 17_000_000, method: 'karta', label: 'Yong‘oq xaridi', fiscal: true, source: 'seed', occurredAt: addDays(m3, 14) },
    { userId, kind: 'exp', amount: 3_000_000, method: 'naqd', label: 'Ijara to‘lovi', fiscal: false, source: 'seed', occurredAt: addDays(m3, 20) },
    { userId, kind: 'exp', amount: 3_000_000, method: 'karta', label: 'Transport va kommunal', fiscal: true, source: 'seed', occurredAt: addDays(m3, 22) },

    // Month -2 (net profit = 6,000,000; naqd +2M, karta +4M)
    { userId, kind: 'sale', amount: 23_000_000, method: 'naqd', label: 'Savdo (naqd)', fiscal: false, source: 'seed', occurredAt: addDays(m2, 5) },
    { userId, kind: 'sale', amount: 25_000_000, method: 'karta', label: 'Savdo (terminal)', fiscal: true, source: 'seed', occurredAt: addDays(m2, 12) },
    { userId, kind: 'buy', amount: 18_000_000, method: 'naqd', label: 'Quritilgan o‘rik xaridi', fiscal: false, source: 'seed', occurredAt: addDays(m2, 7) },
    { userId, kind: 'buy', amount: 18_000_000, method: 'karta', label: 'Pista va bodom xaridi', fiscal: true, source: 'seed', occurredAt: addDays(m2, 15) },
    { userId, kind: 'exp', amount: 3_000_000, method: 'naqd', label: 'Ijara to‘lovi', fiscal: false, source: 'seed', occurredAt: addDays(m2, 20) },
    { userId, kind: 'exp', amount: 3_000_000, method: 'karta', label: 'Qadoqlash va logistika', fiscal: true, source: 'seed', occurredAt: addDays(m2, 23) },

    // Month -1 (net profit = 6,000,000; naqd +2M, karta +4M)
    { userId, kind: 'sale', amount: 24_000_000, method: 'naqd', label: 'Savdo (naqd)', fiscal: false, source: 'seed', occurredAt: addDays(m1, 5) },
    { userId, kind: 'sale', amount: 26_000_000, method: 'karta', label: 'Savdo (terminal)', fiscal: true, source: 'seed', occurredAt: addDays(m1, 14) },
    { userId, kind: 'buy', amount: 19_000_000, method: 'naqd', label: 'Samarqand mayiz partiyasi', fiscal: false, source: 'seed', occurredAt: addDays(m1, 8) },
    { userId, kind: 'buy', amount: 19_000_000, method: 'karta', label: 'Keshu va funduk xaridi', fiscal: true, source: 'seed', occurredAt: addDays(m1, 16) },
    { userId, kind: 'exp', amount: 3_000_000, method: 'naqd', label: 'Ijara to‘lovi', fiscal: false, source: 'seed', occurredAt: addDays(m1, 20) },
    { userId, kind: 'exp', amount: 3_000_000, method: 'karta', label: 'Bozor va transport', fiscal: true, source: 'seed', occurredAt: addDays(m1, 24) },

    // Owner profit withdrawals (fix) to calibrate exact reference cash balances
    { userId, kind: 'fix', amount: -4_000_000, method: 'naqd', label: 'Oila xarajati / sverka', fiscal: false, source: 'seed', occurredAt: addDays(m1, 26) },
    { userId, kind: 'fix', amount: -10_000_000, method: 'karta', label: 'Foydadan yechish / sverka', fiscal: false, source: 'seed', occurredAt: addDays(m1, 26) },

    // Current month (sales = 50,000,000 -> 1% tax = 500,000; net profit = 8,000,000; naqd +2.8M, karta +5.2M)
    // Final cash: naqd = 6M - 4M + 2.8M = 4,800,000; karta = 12M - 10M + 5.2M = 7,200,000 => cash = 12,000,000
    { userId, kind: 'sale', amount: 22_000_000, method: 'naqd', label: 'Chorsu naqd savdo', fiscal: false, source: 'seed', occurredAt: new Date(m0.getTime() + 9 * 3600_000) },
    { userId, kind: 'sale', amount: 28_000_000, method: 'karta', label: 'Terminal va Click savdo', fiscal: true, source: 'seed', occurredAt: new Date(m0.getTime() + 10 * 3600_000) },
    { userId, kind: 'buy', amount: 16_000_000, method: 'naqd', label: 'Yangi partiya (naqd)', fiscal: false, source: 'seed', occurredAt: new Date(m0.getTime() + 11 * 3600_000) },
    { userId, kind: 'buy', amount: 20_000_000, method: 'karta', label: 'Yangi partiya (karta)', fiscal: true, source: 'seed', occurredAt: new Date(m0.getTime() + 12 * 3600_000) },
    { userId, kind: 'exp', amount: 3_200_000, method: 'naqd', label: 'Yuk tashish va qadoqlash', fiscal: false, source: 'seed', occurredAt: new Date(m0.getTime() + 13 * 3600_000) },
    { userId, kind: 'exp', amount: 2_800_000, method: 'karta', label: 'Sovutkich va kommunal', fiscal: true, source: 'seed', occurredAt: new Date(m0.getTime() + 14 * 3600_000) },

    // Nasiya debts (does NOT affect cash)
    { userId, kind: 'nas', amount: 1_400_000, method: 'none', label: 'Bodom va mayiz nasiya', counterpartyId: akmal.id, fiscal: false, source: 'seed', occurredAt: addDays(now, -18) },
    { userId, kind: 'nas', amount: 950_000, method: 'none', label: 'Yong‘oq nasiya', counterpartyId: sardor.id, fiscal: false, source: 'seed', occurredAt: addDays(now, -7) },
  ]);

  const rentDue = addDays(now, 5);
  const supDue = addDays(now, 10);
  const rentDueParts = getTashkentParts(rentDue);

  await db.insert(obligations).values([
    {
      userId,
      kind: 'rent',
      title: 'Chorsu rasta ijarasi',
      amount: 3_000_000,
      dueDay: rentDueParts.day,
      dueDate: null,
      recurring: true,
      counterpartyId: null,
    },
    {
      userId,
      kind: 'supplier',
      title: 'Samarqand Mayiz Opt to‘lovi',
      amount: 3_100_000,
      dueDay: null,
      dueDate: toTashkentDateString(supDue),
      recurring: false,
      counterpartyId: supplier.id,
    },
  ]);

  await db.insert(memoryFacts).values([
    {
      userId,
      key: 'main_supplier',
      value: 'Samarqand Mayiz Opt — asosiy ulgurji ta’minotchi',
    },
    {
      userId,
      key: 'expansion_goal',
      value: 'Chorsu bozorida ikkinchi rasta ochish uchun 34 mln so‘m kredit ko‘rib chiqilmoqda',
    },
  ]);

  await db.insert(chats).values({
    userId,
    title: 'Kredit va kassa tahlili',
    topic: 'loan',
  });

  return user!;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seedDemoUser()
    .then((u) => {
      console.log(`[seed-demo] Dilnoza demo account ready (id=${u.id}, phone=${u.phone})`);
    })
    .catch((err) => {
      console.error('[seed-demo] failed:', err);
      process.exit(1);
    });
}
