import { and, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';
import { getDb } from '../../config/db.js';
import {
  businesses,
  businessStatusHistory,
  ops,
  palataSnapshots,
  users,
} from '../../db/schema.js';
import { toSafeInt } from '../../utils/money.js';
import { addDays, toTashkentDateString } from '../../utils/time.js';

export const K_ANONYMITY_MIN = 5;

export interface MerchantAggregateInput {
  userId: string;
  sector: string;
  market: string;
  status: string;
  totalSales: number;
  fiscalSales: number;
  cashSales: number;
  nasiyaSales: number;
  totalCosts: number;
  formalizedInWindow: boolean;
}

export interface SliceMetrics {
  unaccounted_turnover_share_pct: number;
  fiscalized_share_pct: number;
  unregistered_share_pct: number;
  formalized_count: number;
  avg_monthly_revenue: number;
  median_monthly_revenue: number;
  avg_margin_pct: number;
  cash_share_pct: number;
  nasiya_share_pct: number;
  total_turnover: number;
}

export interface SnapshotSlice {
  cut: 'all' | 'sector' | 'market';
  cutKey: string;
  n: number;
  metrics: SliceMetrics;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function computeMetricsForGroup(
  group: MerchantAggregateInput[],
  windowDays: number,
): SliceMetrics {
  const n = group.length;
  const monthsFactor = Math.max(1, windowDays / 30);

  let totalSales = 0;
  let fiscalSales = 0;
  let cashSales = 0;
  let nasiyaSales = 0;
  let totalCosts = 0;
  let unregisteredCount = 0;
  let formalizedCount = 0;
  const monthlyRevenues: number[] = [];

  for (const m of group) {
    totalSales += m.totalSales;
    fiscalSales += m.fiscalSales;
    cashSales += m.cashSales;
    nasiyaSales += m.nasiyaSales;
    totalCosts += m.totalCosts;
    if (m.status === 'none') unregisteredCount += 1;
    if (m.formalizedInWindow) formalizedCount += 1;
    monthlyRevenues.push(Math.round(m.totalSales / monthsFactor));
  }

  const unaccountedSales = Math.max(0, totalSales - fiscalSales);
  const unaccountedPct =
    totalSales > 0 ? Number(((unaccountedSales / totalSales) * 100).toFixed(1)) : 0;
  const fiscalizedPct = Number((100 - unaccountedPct).toFixed(1));
  const unregisteredPct = n > 0 ? Number(((unregisteredCount / n) * 100).toFixed(1)) : 0;
  const avgMonthlyRev =
    n > 0 ? Math.round(monthlyRevenues.reduce((a, b) => a + b, 0) / n) : 0;
  const medianMonthlyRev = median(monthlyRevenues);
  const avgMarginPct =
    totalSales > 0
      ? Number((((totalSales - totalCosts) / totalSales) * 100).toFixed(1))
      : 0;
  const cashSharePct =
    totalSales > 0 ? Number(((cashSales / totalSales) * 100).toFixed(1)) : 0;
  const nasiyaSharePct =
    totalSales + nasiyaSales > 0
      ? Number(((nasiyaSales / (totalSales + nasiyaSales)) * 100).toFixed(1))
      : 0;

  return {
    unaccounted_turnover_share_pct: unaccountedPct,
    fiscalized_share_pct: fiscalizedPct,
    unregistered_share_pct: unregisteredPct,
    formalized_count: formalizedCount,
    avg_monthly_revenue: avgMonthlyRev,
    median_monthly_revenue: medianMonthlyRev,
    avg_margin_pct: avgMarginPct,
    cash_share_pct: cashSharePct,
    nasiya_share_pct: nasiyaSharePct,
    total_turnover: totalSales,
  };
}

/**
 * Pure k-anonymity slice aggregator: strictly suppresses any slice with n < 5.
 */
export function computeSlicesWithKAnonymity(
  merchants: MerchantAggregateInput[],
  windowDays: number,
): SnapshotSlice[] {
  const slices: SnapshotSlice[] = [];

  if (merchants.length >= K_ANONYMITY_MIN) {
    slices.push({
      cut: 'all',
      cutKey: 'all',
      n: merchants.length,
      metrics: computeMetricsForGroup(merchants, windowDays),
    });
  }

  const bySector = new Map<string, MerchantAggregateInput[]>();
  const byMarket = new Map<string, MerchantAggregateInput[]>();

  for (const m of merchants) {
    const sList = bySector.get(m.sector) ?? [];
    sList.push(m);
    bySector.set(m.sector, sList);

    const mList = byMarket.get(m.market) ?? [];
    mList.push(m);
    byMarket.set(m.market, mList);
  }

  for (const [sector, list] of bySector.entries()) {
    if (list.length < K_ANONYMITY_MIN) continue; // k-anonymity enforcement
    slices.push({
      cut: 'sector',
      cutKey: sector,
      n: list.length,
      metrics: computeMetricsForGroup(list, windowDays),
    });
  }

  for (const [market, list] of byMarket.entries()) {
    if (list.length < K_ANONYMITY_MIN) continue; // k-anonymity enforcement
    slices.push({
      cut: 'market',
      cutKey: market,
      n: list.length,
      metrics: computeMetricsForGroup(list, windowDays),
    });
  }

  return slices;
}

export async function upsertPalataSlices(
  periodEnd: string,
  windowDays: number,
  slices: SnapshotSlice[],
): Promise<number> {
  const db = getDb();
  let written = 0;

  for (const slice of slices) {
    if (slice.n < K_ANONYMITY_MIN) continue;

    await db
      .insert(palataSnapshots)
      .values({
        periodEnd,
        windowDays,
        cut: slice.cut,
        cutKey: slice.cutKey,
        n: slice.n,
        metrics: slice.metrics as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [
          palataSnapshots.periodEnd,
          palataSnapshots.windowDays,
          palataSnapshots.cut,
          palataSnapshots.cutKey,
        ],
        set: {
          n: slice.n,
          metrics: slice.metrics as unknown as Record<string, unknown>,
        },
      });
    written += 1;
  }

  return written;
}

/**
 * Computes and stores k-anonymous palata_snapshots directly from consented users.
 */
export async function aggregateLivePalataSnapshots(
  windowDays: 30 | 90 = 30,
  now: Date = new Date(),
): Promise<number> {
  const db = getDb();
  const windowStart = addDays(now, -windowDays);
  const periodEnd = toTashkentDateString(now);

  const consented = await db
    .select({
      userId: users.id,
      sector: businesses.sector,
      market: businesses.market,
      status: businesses.status,
    })
    .from(users)
    .innerJoin(businesses, eq(businesses.userId, users.id))
    .where(isNotNull(users.statsConsentAt));

  if (consented.length < K_ANONYMITY_MIN) {
    return 0;
  }

  const [windowOps, statusTransitions] = await Promise.all([
    db
      .select()
      .from(ops)
      .where(and(isNull(ops.deletedAt), gte(ops.occurredAt, windowStart), lte(ops.occurredAt, now))),
    db
      .select()
      .from(businessStatusHistory)
      .where(gte(businessStatusHistory.changedAt, windowStart)),
  ]);

  const formalizedUsers = new Set(
    statusTransitions
      .filter((t) => t.oldStatus === 'none' && t.newStatus !== 'none')
      .map((t) => t.userId),
  );

  const byUser = new Map<string, MerchantAggregateInput>();
  for (const row of consented) {
    byUser.set(row.userId, {
      userId: row.userId,
      sector: row.sector,
      market: row.market,
      status: row.status,
      totalSales: 0,
      fiscalSales: 0,
      cashSales: 0,
      nasiyaSales: 0,
      totalCosts: 0,
      formalizedInWindow: formalizedUsers.has(row.userId),
    });
  }

  for (const op of windowOps) {
    const entry = byUser.get(op.userId);
    if (!entry) continue;
    const amt = toSafeInt(op.amount);
    if (op.kind === 'sale') {
      entry.totalSales += amt;
      if (op.fiscal) entry.fiscalSales += amt;
      if (op.method === 'naqd') entry.cashSales += amt;
    } else if (op.kind === 'nas') {
      entry.nasiyaSales += amt;
    } else if (op.kind === 'buy' || op.kind === 'exp' || op.kind === 'sup') {
      entry.totalCosts += amt;
    }
  }

  const slices = computeSlicesWithKAnonymity(Array.from(byUser.values()), windowDays);
  return upsertPalataSlices(periodEnd, windowDays, slices);
}
