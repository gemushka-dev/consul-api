import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/db.js';
import { surveyAnswers, users } from '../db/schema.js';
import {
  computeSlicesWithKAnonymity,
  upsertPalataSlices,
  type MerchantAggregateInput,
} from '../modules/palata/palata.aggregator.js';
import { startOfTashkentMonth, toTashkentDateString } from '../utils/time.js';

const SECTORS = ['dried_fruit', 'food', 'clothes', 'services', 'other'] as const;
const MARKETS = ['chorsu', 'oloy', 'parkent', 'quyliq', 'other'] as const;
const SURVEY_REASONS = [
  { code: 'tax_complexity', weight: 0.34 },
  { code: 'fear_of_audits', weight: 0.25 },
  { code: 'accounting_cost', weight: 0.19 },
  { code: 'small_turnover', weight: 0.14 },
  { code: 'lack_of_info', weight: 0.08 },
] as const;

/** Simple deterministic Mulberry32 PRNG for repeatable hackathon demos */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends { weight: number }>(items: readonly T[], r: number): T {
  let acc = 0;
  for (const item of items) {
    acc += item.weight;
    if (r <= acc) return item;
  }
  return items[items.length - 1]!;
}

/**
 * Generates 812 realistic synthetic entrepreneurs across Tashkent markets and sectors,
 * computes 6 monthly k-anonymous snapshots (window=30 and window=90), and populates survey_answers.
 */
export async function seedPalataData(
  entrepreneurCount = 812,
  now: Date = new Date(),
): Promise<{ entrepreneurs: number; snapshotsWritten: number; surveyAnswersWritten: number }> {
  const rand = mulberry32(20261118);
  const db = getDb();

  let snapshotsWritten = 0;

  // Generate 6 monthly snapshots showing gradual formalization improvement over 6 months
  for (let monthOffset = -5; monthOffset <= 0; monthOffset++) {
    const periodDate = monthOffset === 0 ? now : startOfTashkentMonth(now, monthOffset + 1);
    const periodEnd = toTashkentDateString(
      monthOffset === 0 ? periodDate : new Date(periodDate.getTime() - 24 * 3600_000),
    );
    const formalizationBoost = (monthOffset + 5) * 0.028; // gradual shift toward white business

    for (const windowDays of [30, 90] as const) {
      const monthsMult = windowDays / 30;
      const merchants: MerchantAggregateInput[] = [];

      for (let i = 0; i < entrepreneurCount; i++) {
        const sector = SECTORS[Math.floor(rand() * SECTORS.length)]!;
        const market = MARKETS[Math.floor(rand() * MARKETS.length)]!;

        const unregisteredProb = Math.max(0.18, 0.44 - formalizationBoost);
        const isUnregistered = rand() < unregisteredProb;
        const status = isUnregistered ? 'none' : rand() < 0.72 ? 'yatt' : rand() < 0.85 ? 'oob' : 'mchj';

        const baseMonthlyRevenue =
          sector === 'dried_fruit'
            ? 42_000_000
            : sector === 'clothes'
              ? 55_000_000
              : sector === 'food'
                ? 60_000_000
                : sector === 'services'
                  ? 28_000_000
                  : 35_000_000;

        const monthlyRevenue = Math.round(baseMonthlyRevenue * (0.55 + rand() * 0.95));
        const totalSales = Math.round(monthlyRevenue * monthsMult);

        const baseFiscalRatio = isUnregistered ? 0.08 + rand() * 0.12 : 0.48 + formalizationBoost + rand() * 0.25;
        const fiscalSales = Math.min(totalSales, Math.round(totalSales * Math.min(0.95, baseFiscalRatio)));
        const cashSales = Math.round(totalSales * (0.42 + rand() * 0.35));
        const nasiyaSales = Math.round(totalSales * (0.05 + rand() * 0.12));
        const marginPct = 0.14 + rand() * 0.14;
        const totalCosts = Math.round(totalSales * (1 - marginPct));
        const formalizedInWindow = !isUnregistered && rand() < 0.045 * monthsMult;

        merchants.push({
          userId: `synth-${i}`,
          sector,
          market,
          status,
          totalSales,
          fiscalSales,
          cashSales,
          nasiyaSales,
          totalCosts,
          formalizedInWindow,
        });
      }

      const slices = computeSlicesWithKAnonymity(merchants, windowDays);
      snapshotsWritten += await upsertPalataSlices(periodEnd, windowDays, slices);
    }
  }

  // Seed anonymized survey responses anchored to a dedicated synthetic panel owner
  const panelEmail = 'palata-panel@consul.uz';
  const existingPanel = await db.select().from(users).where(eq(users.email, panelEmail)).limit(1);
  let panelUserId = existingPanel[0]?.id;
  if (!panelUserId) {
    const [created] = await db
      .insert(users)
      .values({
        email: panelEmail,
        role: 'chamber',
        lang: 'uz',
        consentAt: now,
        statsConsentAt: now,
      })
      .returning();
    panelUserId = created!.id;
  }

  await db.delete(surveyAnswers).where(eq(surveyAnswers.userId, panelUserId));

  const surveyBatch = [];
  const surveyCount = 240;
  for (let i = 0; i < surveyCount; i++) {
    const picked = pickWeighted(SURVEY_REASONS, rand());
    surveyBatch.push({
      userId: panelUserId,
      question: 'why_not_registered',
      answer: picked.code,
    });
  }
  await db.insert(surveyAnswers).values(surveyBatch);

  return {
    entrepreneurs: entrepreneurCount,
    snapshotsWritten,
    surveyAnswersWritten: surveyCount,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seedPalataData()
    .then((res) => {
      console.log(
        `[seed-palata] seeded ${res.entrepreneurs} synthetic entrepreneurs -> ${res.snapshotsWritten} k-anonymous snapshots, ${res.surveyAnswersWritten} survey answers`,
      );
    })
    .catch((err) => {
      console.error('[seed-palata] failed:', err);
      process.exit(1);
    });
}
