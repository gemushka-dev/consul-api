import { and, desc, eq, isNull } from 'drizzle-orm';
import OpenAI from 'openai';
import { getDb } from '../../config/db.js';
import { env } from '../../config/env.js';
import { businesses, businessPlans, ops } from '../../db/schema.js';
import type { SupportedLang } from '../../types/express.d.js';
import { formatMoney, toSafeInt } from '../../utils/money.js';
import { startOfTashkentMonth } from '../../utils/time.js';
import {
  calculateLoan,
  calculateSafeLoan,
  computeMonthlyTaxAmount,
} from '../calculators/calculators.engine.js';
import { computeMonthSummary } from '../ledger/ledger.math.js';
import { loadUserTodayDashboard } from '../ledger/ops.service.js';

export async function generateBankReport(
  userId: string,
  monthsCount = 3,
  lang: SupportedLang = 'uz',
) {
  const clamped = Math.min(12, Math.max(1, Math.trunc(monthsCount)));
  const db = getDb();
  const [activeOps, bizRows, today] = await Promise.all([
    db.select().from(ops).where(and(eq(ops.userId, userId), isNull(ops.deletedAt))),
    db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1),
    loadUserTodayDashboard(userId, lang),
  ]);

  const biz = bizRows[0] ?? null;
  const now = new Date();
  const months = [];

  for (let offset = -clamped; offset <= -1; offset++) {
    const start = startOfTashkentMonth(now, offset);
    const end = startOfTashkentMonth(now, offset + 1);
    const summary = computeMonthSummary(activeOps, start, end);
    const totalOutflow = summary.buys + summary.expenses + summary.supplier_payments;
    const taxCalc = computeMonthlyTaxAmount({
      monthlyTurnover: summary.sales,
      monthlyExpenses: totalOutflow,
      status: biz?.status ?? 'yatt',
      regime: biz?.regime ?? 'turnover',
    });

    months.push({
      month: summary.month,
      income: summary.sales,
      expenses: totalOutflow,
      profit: summary.profit,
      margin: summary.margin,
      tax: taxCalc.tax,
    });
  }

  const totalIncome = months.reduce((a, m) => a + m.income, 0);
  const totalExpenses = months.reduce((a, m) => a + m.expenses, 0);
  const totalProfit = months.reduce((a, m) => a + m.profit, 0);
  const totalTax = months.reduce((a, m) => a + m.tax, 0);

  return {
    generated_at: now.toISOString(),
    period_months: clamped,
    business: biz
      ? {
          trade: biz.trade,
          sector: biz.sector,
          market: biz.market,
          status: biz.status,
          regime: biz.regime,
        }
      : null,
    summary: {
      total_income: totalIncome,
      total_expenses: totalExpenses,
      total_profit: totalProfit,
      total_tax: totalTax,
      avg_monthly_income: Math.round(totalIncome / clamped),
      avg_monthly_profit: Math.round(totalProfit / clamped),
      current_cash: today.view.cash,
      current_obligations: today.view.obligations,
      current_free_cash: today.view.free,
      owed_to_me: today.view.owed_to_me,
    },
    months,
  };
}

export async function runWhatIfForecast(params: {
  userId: string;
  scenario: 'buy' | 'helper' | 'loan';
  amount: number;
  dayOffset?: number;
  annualRate?: number;
  months?: number;
  lang: SupportedLang;
}) {
  const today = await loadUserTodayDashboard(params.userId, params.lang);
  const dayOffset = Math.min(29, Math.max(0, params.dayOffset ?? 1));

  let monthlyImpact = params.amount;
  let loanDetails: Record<string, unknown> | null = null;

  if (params.scenario === 'loan') {
    const annualRate = params.annualRate ?? 24;
    const months = params.months ?? 24;
    const loan = calculateLoan({
      principal: params.amount,
      annual_rate: annualRate,
      months,
      kind: 'annuity',
    });
    const safe = calculateSafeLoan({
      profit_3m: today.view.profit_3m,
      annual_rate: annualRate,
      months,
      requested_principal: params.amount,
    });
    monthlyImpact = loan.monthly_payment;
    loanDetails = {
      principal: params.amount,
      annual_rate: annualRate,
      months,
      monthly_payment: loan.monthly_payment,
      total_interest: loan.total_interest,
      debt_to_profit_pct: safe.debt_to_profit_pct,
      verdict: safe.verdict,
    };
  }

  let minProjectedCash = Number.POSITIVE_INFINITY;
  let firstGapDate: string | null = null;

  const forecast = today.forecast.map((day, idx) => {
    const extraOutflow = idx >= dayOffset ? monthlyImpact : 0;
    const projectedCash = day.projected_cash - extraOutflow;
    const cashGap = projectedCash - today.view.reserve < 0;
    if (projectedCash < minProjectedCash) minProjectedCash = projectedCash;
    if (cashGap && !firstGapDate) firstGapDate = day.date;

    return {
      date: day.date,
      baseline_cash: day.projected_cash,
      projected_cash: projectedCash,
      extra_outflow: idx === dayOffset ? monthlyImpact : 0,
      cash_gap: cashGap,
    };
  });

  const freeAfter = today.view.free - monthlyImpact;
  const hasCashGap = firstGapDate !== null;

  const recommendation =
    params.lang === 'ru'
      ? hasCashGap
        ? `Внимание: сценарий "${params.scenario}" создаёт кассовый разрыв ${firstGapDate} (минимум ${formatMoney(minProjectedCash)} сум при резерве ${formatMoney(today.view.reserve)} сум).`
        : `Сценарий "${params.scenario}" безопасен на горизонте 30 дней: свободный остаток составит ${formatMoney(freeAfter)} сум без кассового разрыва.`
      : hasCashGap
        ? `Diqqat: "${params.scenario}" ssenariysi ${firstGapDate} kuni kassa uzilishiga olib keladi (minimal qoldiq ${formatMoney(minProjectedCash)} so'm, zaxira ${formatMoney(today.view.reserve)} so'm).`
        : `"${params.scenario}" ssenariysi 30 kun ichida xavfsiz: bo'sh qoldiq ${formatMoney(freeAfter)} so'm bo'ladi, kassa uzilishi yo'q.`;

  return {
    scenario: params.scenario,
    amount: params.amount,
    monthly_impact: monthlyImpact,
    day_offset: dayOffset,
    free_before: today.view.free,
    free_after: freeAfter,
    reserve: today.view.reserve,
    min_projected_cash: minProjectedCash,
    has_cash_gap: hasCashGap,
    first_gap_date: firstGapDate,
    loan_details: loanDetails,
    recommendation,
    forecast,
  };
}

export async function generateBusinessPlan(params: {
  userId: string;
  title?: string;
  goal: string;
  investment: number;
  targetMonthlySales?: number;
  lang: SupportedLang;
}) {
  const db = getDb();
  const [bankReport, today] = await Promise.all([
    generateBankReport(params.userId, 3, params.lang),
    loadUserTodayDashboard(params.userId, params.lang),
  ]);

  const historicalMarginPct =
    bankReport.summary.total_income > 0
      ? Number(
          ((bankReport.summary.total_profit / bankReport.summary.total_income) * 100).toFixed(1),
        )
      : 16;
  const costRatioPct = Number((100 - historicalMarginPct).toFixed(1));
  const baselineMonthlySales = Math.max(
    bankReport.summary.avg_monthly_income,
    today.month.current.sales,
    30_000_000,
  );
  const projectedMonthlySales =
    params.targetMonthlySales ?? Math.round(baselineMonthlySales * 1.35);
  const incrementalSales = Math.max(1_000_000, projectedMonthlySales - baselineMonthlySales);
  const projectedMonthlyProfit = Math.round((projectedMonthlySales * historicalMarginPct) / 100);
  const incrementalMonthlyProfit = Math.max(
    500_000,
    Math.round((incrementalSales * historicalMarginPct) / 100),
  );
  const paybackMonths = Number((params.investment / incrementalMonthlyProfit).toFixed(1));
  const annualRoiPct = Number(
    (((incrementalMonthlyProfit * 12) / params.investment) * 100).toFixed(1),
  );

  const structured = {
    goal: params.goal,
    investment: params.investment,
    historical_avg_monthly_sales: baselineMonthlySales,
    historical_margin_pct: historicalMarginPct,
    historical_cost_ratio_pct: costRatioPct,
    projected_monthly_sales: projectedMonthlySales,
    projected_monthly_profit: projectedMonthlyProfit,
    incremental_monthly_profit: incrementalMonthlyProfit,
    payback_months: paybackMonths,
    annual_roi_pct: annualRoiPct,
    current_free_cash: today.view.free,
  };

  const planTitle =
    params.title ??
    (params.lang === 'ru'
      ? `Бизнес-план: ${params.goal.slice(0, 60)}`
      : `Biznes-reja: ${params.goal.slice(0, 60)}`);

  let content =
    params.lang === 'ru'
      ? `## ${planTitle}\n\n` +
        `**Цель:** ${params.goal}\n` +
        `**Инвестиции:** ${formatMoney(params.investment)} сум\n\n` +
        `### База из реального учёта (3 мес.)\n` +
        `- Средняя выручка: ${formatMoney(baselineMonthlySales)} сум/мес\n` +
        `- Себестоимость и расходы: ${costRatioPct}% (маржа ${historicalMarginPct}%)\n` +
        `- Свободные средства сейчас: ${formatMoney(today.view.free)} сум\n\n` +
        `### Прогноз\n` +
        `- Целевая выручка: ${formatMoney(projectedMonthlySales)} сум/мес\n` +
        `- Ожидаемая чистая прибыль: ${formatMoney(projectedMonthlyProfit)} сум/мес (+${formatMoney(incrementalMonthlyProfit)} сум прироста)\n` +
        `- Срок окупаемости: ${paybackMonths} мес. (ROI ${annualRoiPct}% годовых)`
      : `## ${planTitle}\n\n` +
        `**Maqsad:** ${params.goal}\n` +
        `**Investitsiya:** ${formatMoney(params.investment)} so'm\n\n` +
        `### Haqiqiy hisob ma'lumotlari (3 oy)\n` +
        `- O'rtacha oylik savdo: ${formatMoney(baselineMonthlySales)} so'm\n` +
        `- Tannarx va xarajatlar ulushi: ${costRatioPct}% (marja ${historicalMarginPct}%)\n` +
        `- Hozirgi bo'sh mablag': ${formatMoney(today.view.free)} so'm\n\n` +
        `### Prognoz\n` +
        `- Maqsadli oylik savdo: ${formatMoney(projectedMonthlySales)} so'm\n` +
        `- Kutilayotgan sof foyda: ${formatMoney(projectedMonthlyProfit)} so'm/oy (+${formatMoney(incrementalMonthlyProfit)} so'm o'sish)\n` +
        `- O'zini qoplash muddati: ${paybackMonths} oy (yillik ROI ${annualRoiPct}%)`;

  let model = 'deterministic-advisor';
  let tokensIn = 0;
  let tokensOut = 0;

  if (env.AI_API_KEY) {
    try {
      const client = new OpenAI({
        apiKey: env.AI_API_KEY,
        baseURL: env.AI_BASE_URL,
        timeout: 12_000,
      });
      const completion = await client.chat.completions.create({
        model: env.AI_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `Write a concise, practical business plan in ${params.lang} using ONLY the exact numbers provided in the JSON context.`,
          },
          {
            role: 'user',
            content: JSON.stringify(structured),
          },
        ],
      });
      const llmText = completion.choices[0]?.message?.content?.trim();
      if (llmText) {
        content = llmText;
        model = env.AI_MODEL;
        tokensIn = completion.usage?.prompt_tokens ?? 0;
        tokensOut = completion.usage?.completion_tokens ?? 0;
      }
    } catch {
      // Keep deterministic grounded business plan on LLM timeout/error
    }
  }

  const inserted = await db
    .insert(businessPlans)
    .values({
      userId: params.userId,
      title: planTitle,
      input: {
        goal: params.goal,
        investment: params.investment,
        target_monthly_sales: projectedMonthlySales,
      },
      content,
      structured,
      toolCalls: [{ name: 'generate_bank_report', months: 3 }],
      lang: params.lang,
      model,
      tokensIn,
      tokensOut,
    })
    .returning();

  const saved = inserted[0]!;
  return {
    id: saved.id,
    title: saved.title,
    content: saved.content,
    structured: saved.structured,
    lang: saved.lang,
    model: saved.model,
    created_at: saved.createdAt.toISOString(),
  };
}

function escapeCsv(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function exportUserOpsCsv(userId: string): Promise<string> {
  const db = getDb();
  const rows = await db
    .select()
    .from(ops)
    .where(and(eq(ops.userId, userId), isNull(ops.deletedAt)))
    .orderBy(desc(ops.occurredAt));

  const header = [
    'id',
    'occurred_at',
    'kind',
    'amount_uzs',
    'method',
    'fiscal',
    'source',
    'label',
  ];

  const lines = [
    header.join(';'),
    ...rows.map((r) =>
      [
        r.id,
        r.occurredAt.toISOString(),
        r.kind,
        toSafeInt(r.amount),
        r.method,
        r.fiscal ? '1' : '0',
        r.source,
        r.label ?? '',
      ]
        .map(escapeCsv)
        .join(';'),
    ),
  ];

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
