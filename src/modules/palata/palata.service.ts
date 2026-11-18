import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '../../config/db.js';
import { palataSnapshots, surveyAnswers } from '../../db/schema.js';
import { K_ANONYMITY_MIN, type SliceMetrics } from './palata.aggregator.js';

export const OFFICIAL_STATISTICS_REFERENCE = {
  source: 'Statistics Agency under the President of the Republic of Uzbekistan (stat.uz, 2025/2026)',
  estimated_shadow_economy_gdp_pct: 33.3,
  informal_retail_cash_share_pct: 61.5,
  target_formalization_note:
    'Consul k-anonymous merchant panel provides real-time ground truth on bazaar & micro-retail turnover.',
};

export interface PalataReportResponse {
  window_days: 30 | 90;
  period_end: string | null;
  k_anonymity_min: number;
  kpi: (SliceMetrics & { n: number }) | null;
  trend_6m: Array<{
    period_end: string;
    n: number;
    unaccounted_turnover_share_pct: number;
    fiscalized_share_pct: number;
    formalized_count: number;
    avg_monthly_revenue: number;
  }>;
  by_sector: Array<{ key: string; n: number; metrics: SliceMetrics }>;
  by_market: Array<{ key: string; n: number; metrics: SliceMetrics }>;
  survey: {
    question: string;
    total_responses: number;
    breakdown: Array<{ answer: string; count: number; share_pct: number }>;
  };
  official_reference: typeof OFFICIAL_STATISTICS_REFERENCE;
}

/**
 * Reads ONLY from palata_snapshots (NEVER queries ops directly).
 * Guarantees k-anonymity n >= 5 across every returned slice.
 */
export async function getPalataReport(windowDays: 30 | 90 = 30): Promise<PalataReportResponse> {
  const db = getDb();

  const [snapshots, surveys] = await Promise.all([
    db
      .select()
      .from(palataSnapshots)
      .where(and(eq(palataSnapshots.windowDays, windowDays), gte(palataSnapshots.n, K_ANONYMITY_MIN)))
      .orderBy(desc(palataSnapshots.periodEnd)),
    db.select().from(surveyAnswers),
  ]);

  const latestPeriod = snapshots[0]?.periodEnd ?? null;

  const latestAll = latestPeriod
    ? snapshots.find((s) => s.periodEnd === latestPeriod && s.cut === 'all' && s.cutKey === 'all')
    : undefined;

  const trend6m = snapshots
    .filter((s) => s.cut === 'all' && s.cutKey === 'all')
    .slice(0, 6)
    .reverse()
    .map((s) => {
      const m = s.metrics as unknown as SliceMetrics;
      return {
        period_end: s.periodEnd,
        n: s.n,
        unaccounted_turnover_share_pct: m.unaccounted_turnover_share_pct,
        fiscalized_share_pct: m.fiscalized_share_pct,
        formalized_count: m.formalized_count,
        avg_monthly_revenue: m.avg_monthly_revenue,
      };
    });

  const bySector = latestPeriod
    ? snapshots
        .filter((s) => s.periodEnd === latestPeriod && s.cut === 'sector' && s.n >= K_ANONYMITY_MIN)
        .map((s) => ({
          key: s.cutKey,
          n: s.n,
          metrics: s.metrics as unknown as SliceMetrics,
        }))
        .sort((a, b) => b.n - a.n)
    : [];

  const byMarket = latestPeriod
    ? snapshots
        .filter((s) => s.periodEnd === latestPeriod && s.cut === 'market' && s.n >= K_ANONYMITY_MIN)
        .map((s) => ({
          key: s.cutKey,
          n: s.n,
          metrics: s.metrics as unknown as SliceMetrics,
        }))
        .sort((a, b) => b.n - a.n)
    : [];

  // Aggregate survey answers (k-anonymity suppressed if total < 5)
  const answerCounts = new Map<string, number>();
  const primaryQuestion = surveys[0]?.question ?? 'why_not_registered';
  for (const row of surveys) {
    answerCounts.set(row.answer, (answerCounts.get(row.answer) ?? 0) + 1);
  }
  const totalSurvey = surveys.length;
  const surveyBreakdown =
    totalSurvey >= K_ANONYMITY_MIN
      ? Array.from(answerCounts.entries())
          .map(([answer, count]) => ({
            answer,
            count,
            share_pct: Number(((count / totalSurvey) * 100).toFixed(1)),
          }))
          .sort((a, b) => b.count - a.count)
      : [];

  return {
    window_days: windowDays,
    period_end: latestPeriod,
    k_anonymity_min: K_ANONYMITY_MIN,
    kpi: latestAll
      ? { n: latestAll.n, ...(latestAll.metrics as unknown as SliceMetrics) }
      : null,
    trend_6m: trend6m,
    by_sector: bySector,
    by_market: byMarket,
    survey: {
      question: primaryQuestion,
      total_responses: totalSurvey,
      breakdown: surveyBreakdown,
    },
    official_reference: OFFICIAL_STATISTICS_REFERENCE,
  };
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Generates semicolon-delimited CSV with UTF-8 BOM (\uFEFF) for Excel compatibility.
 */
export async function exportPalataReportCsv(windowDays: 30 | 90 = 30): Promise<string> {
  const report = await getPalataReport(windowDays);
  const header = [
    'period_end',
    'window_days',
    'cut',
    'cut_key',
    'n',
    'unaccounted_turnover_share_pct',
    'fiscalized_share_pct',
    'unregistered_share_pct',
    'formalized_count',
    'avg_monthly_revenue_uzs',
    'median_monthly_revenue_uzs',
    'avg_margin_pct',
    'cash_share_pct',
    'nasiya_share_pct',
  ];

  const rows: string[][] = [];

  if (report.kpi && report.period_end) {
    rows.push([
      report.period_end,
      String(report.window_days),
      'all',
      'all',
      String(report.kpi.n),
      String(report.kpi.unaccounted_turnover_share_pct),
      String(report.kpi.fiscalized_share_pct),
      String(report.kpi.unregistered_share_pct),
      String(report.kpi.formalized_count),
      String(report.kpi.avg_monthly_revenue),
      String(report.kpi.median_monthly_revenue),
      String(report.kpi.avg_margin_pct),
      String(report.kpi.cash_share_pct),
      String(report.kpi.nasiya_share_pct),
    ]);
  }

  for (const s of report.by_sector) {
    rows.push([
      report.period_end ?? '',
      String(report.window_days),
      'sector',
      s.key,
      String(s.n),
      String(s.metrics.unaccounted_turnover_share_pct),
      String(s.metrics.fiscalized_share_pct),
      String(s.metrics.unregistered_share_pct),
      String(s.metrics.formalized_count),
      String(s.metrics.avg_monthly_revenue),
      String(s.metrics.median_monthly_revenue),
      String(s.metrics.avg_margin_pct),
      String(s.metrics.cash_share_pct),
      String(s.metrics.nasiya_share_pct),
    ]);
  }

  for (const m of report.by_market) {
    rows.push([
      report.period_end ?? '',
      String(report.window_days),
      'market',
      m.key,
      String(m.n),
      String(m.metrics.unaccounted_turnover_share_pct),
      String(m.metrics.fiscalized_share_pct),
      String(m.metrics.unregistered_share_pct),
      String(m.metrics.formalized_count),
      String(m.metrics.avg_monthly_revenue),
      String(m.metrics.median_monthly_revenue),
      String(m.metrics.avg_margin_pct),
      String(m.metrics.cash_share_pct),
      String(m.metrics.nasiya_share_pct),
    ]);
  }

  const lines = [
    header.map(escapeCsvCell).join(';'),
    ...rows.map((r) => r.map(escapeCsvCell).join(';')),
  ];

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function recordSurveyAnswer(userId: string, question: string, answer: string) {
  const db = getDb();
  const inserted = await db
    .insert(surveyAnswers)
    .values({
      userId,
      question,
      answer,
    })
    .returning();

  const row = inserted[0]!;
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    created_at: row.createdAt.toISOString(),
  };
}
