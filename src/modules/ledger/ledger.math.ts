import type {
  BusinessRow,
  CounterpartyRow,
  ObligationRow,
  OpRow,
} from '../../db/schema.js';
import type { SupportedLang } from '../../types/express.d.js';
import { toSafeInt } from '../../utils/money.js';
import {
  addDays,
  daysInMonth,
  diffTashkentDays,
  fromTashkent,
  getTashkentParts,
  startOfTashkentDay,
  startOfTashkentMonth,
  toTashkentDateString,
  toTashkentMonthKey,
} from '../../utils/time.js';
import { computeMonthlyTaxAmount } from '../calculators/calculators.engine.js';

export interface CashBalances {
  cash: number;
  naqd: number;
  karta: number;
}

export interface UpcomingObligationItem {
  id: string;
  kind: string;
  title: string;
  amount: number;
  due_date: string;
  days_until: number;
  recurring: boolean;
}

export interface AttentionItem {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  amount?: number;
}

export interface ForecastDay {
  date: string;
  projected_cash: number;
  scheduled_outflow: number;
  cash_gap: boolean;
}

export interface MonthSummary {
  month: string;
  sales: number;
  buys: number;
  expenses: number;
  supplier_payments: number;
  profit: number;
  margin: number;
}

export interface DebtorSummary {
  id: string;
  name: string;
  phone: string | null;
  debt: number;
  total_nasiya: number;
  total_repaid: number;
  debt_days: number;
  oldest_unpaid_at: string | null;
}

export interface TodayDashboard {
  view: {
    cash: number;
    naqd: number;
    karta: number;
    tax: number;
    obligations: number;
    reserve: number;
    free: number;
    profit: number;
    profit_3m: number;
    margin: number;
    owed_to_me: number;
  };
  upcoming: UpcomingObligationItem[];
  attention: AttentionItem[];
  forecast: ForecastDay[];
  month: {
    current: MonthSummary;
    previous: MonthSummary;
    sales_delta_pct: number | null;
    profit_delta_pct: number | null;
  };
}

/**
 * Computes cash balances strictly from active ops (deleted_at IS NULL):
 * + for sale, repaid, opening
 * - for buy, exp, sup
 * ± for fix
 * nas does NOT affect cash.
 */
export function computeCashBalances(activeOps: OpRow[]): CashBalances {
  let naqd = 0;
  let karta = 0;

  for (const op of activeOps) {
    if (op.deletedAt !== null) continue;
    if (op.method !== 'naqd' && op.method !== 'karta') continue;
    if (op.kind === 'nas') continue;

    const amt = toSafeInt(op.amount);
    let delta = 0;

    switch (op.kind) {
      case 'sale':
      case 'repaid':
      case 'opening':
        delta = amt;
        break;
      case 'buy':
      case 'exp':
      case 'sup':
        delta = -amt;
        break;
      case 'fix':
        delta = amt;
        break;
      default:
        delta = 0;
    }

    if (op.method === 'naqd') naqd += delta;
    else if (op.method === 'karta') karta += delta;
  }

  return {
    cash: naqd + karta,
    naqd,
    karta,
  };
}

export function computeMonthSummary(activeOps: OpRow[], monthStart: Date, monthEnd: Date): MonthSummary {
  let sales = 0;
  let buys = 0;
  let expenses = 0;
  let supplierPayments = 0;

  const startMs = monthStart.getTime();
  const endMs = monthEnd.getTime();

  for (const op of activeOps) {
    if (op.deletedAt !== null) continue;
    const ts = op.occurredAt.getTime();
    if (ts < startMs || ts >= endMs) continue;

    const amt = toSafeInt(op.amount);
    if (op.kind === 'sale') sales += amt;
    else if (op.kind === 'buy') buys += amt;
    else if (op.kind === 'exp') expenses += amt;
    else if (op.kind === 'sup') supplierPayments += amt;
  }

  const profit = sales - buys - expenses - supplierPayments;
  const margin = sales > 0 ? Number(((profit / sales) * 100).toFixed(1)) : 0;

  return {
    month: toTashkentMonthKey(monthStart),
    sales,
    buys,
    expenses,
    supplier_payments: supplierPayments,
    profit,
    margin,
  };
}

/**
 * Average net profit across the 3 CLOSED previous calendar months (Asia/Tashkent).
 */
export function computeProfit3m(activeOps: OpRow[], now: Date = new Date()): number {
  let totalProfit = 0;
  for (let offset = -3; offset <= -1; offset++) {
    const start = startOfTashkentMonth(now, offset);
    const end = startOfTashkentMonth(now, offset + 1);
    const summary = computeMonthSummary(activeOps, start, end);
    totalProfit += summary.profit;
  }
  return Math.round(totalProfit / 3);
}

/**
 * Resolves the next due date within [today, today + 30 days] for an obligation.
 */
export function resolveNextDueDate(ob: ObligationRow, now: Date = new Date()): Date | null {
  const todayStart = startOfTashkentDay(now);
  const windowEnd = addDays(todayStart, 30);

  if (ob.recurring && ob.dueDay && ob.dueDay >= 1 && ob.dueDay <= 31) {
    const { year, month } = getTashkentParts(now);

    for (let monthDelta = 0; monthDelta <= 1; monthDelta++) {
      const totalMonths = year * 12 + (month - 1) + monthDelta;
      const y = Math.floor(totalMonths / 12);
      const m = (totalMonths % 12) + 1;
      const clampedDay = Math.min(ob.dueDay, daysInMonth(y, m));
      const candidate = fromTashkent(y, m, clampedDay, 0, 0, 0);

      if (candidate.getTime() >= todayStart.getTime() && candidate.getTime() <= windowEnd.getTime()) {
        return candidate;
      }
    }
    return null;
  }

  if (ob.dueDate) {
    const [yStr, mStr, dStr] = ob.dueDate.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    if (y && m && d) {
      const candidate = fromTashkent(y, m, d, 0, 0, 0);
      if (candidate.getTime() >= todayStart.getTime() && candidate.getTime() <= windowEnd.getTime()) {
        return candidate;
      }
    }
  }

  return null;
}

export function computeUpcomingObligations(
  obligationRows: ObligationRow[],
  now: Date = new Date(),
): { items: UpcomingObligationItem[]; total: number } {
  const items: UpcomingObligationItem[] = [];

  for (const ob of obligationRows) {
    const due = resolveNextDueDate(ob, now);
    if (!due) continue;
    items.push({
      id: ob.id,
      kind: ob.kind,
      title: ob.title,
      amount: toSafeInt(ob.amount),
      due_date: toTashkentDateString(due),
      days_until: Math.max(0, diffTashkentDays(now, due)),
      recurring: ob.recurring,
    });
  }

  items.sort((a, b) => a.days_until - b.days_until || b.amount - a.amount);
  const total = items.reduce((acc, i) => acc + i.amount, 0);

  return { items, total };
}

export function computeDebtorsSummary(
  activeOps: OpRow[],
  counterpartyRows: CounterpartyRow[],
  now: Date = new Date(),
): DebtorSummary[] {
  const customerMap = new Map<string, CounterpartyRow>();
  for (const cp of counterpartyRows) {
    if (cp.kind === 'customer') {
      customerMap.set(cp.id, cp);
    }
  }

  const acc = new Map<
    string,
    { nas: number; repaid: number; oldestNasAt: Date | null }
  >();

  for (const op of activeOps) {
    if (op.deletedAt !== null || !op.counterpartyId) continue;
    if (!customerMap.has(op.counterpartyId)) continue;
    if (op.kind !== 'nas' && op.kind !== 'repaid') continue;

    const entry = acc.get(op.counterpartyId) ?? { nas: 0, repaid: 0, oldestNasAt: null };
    const amt = toSafeInt(op.amount);
    if (op.kind === 'nas') {
      entry.nas += amt;
      if (!entry.oldestNasAt || op.occurredAt < entry.oldestNasAt) {
        entry.oldestNasAt = op.occurredAt;
      }
    } else if (op.kind === 'repaid') {
      entry.repaid += amt;
    }
    acc.set(op.counterpartyId, entry);
  }

  const result: DebtorSummary[] = [];
  for (const [id, totals] of acc.entries()) {
    const debt = totals.nas - totals.repaid;
    if (debt <= 0) continue;
    const cp = customerMap.get(id)!;
    const debtDays = totals.oldestNasAt ? Math.max(0, diffTashkentDays(totals.oldestNasAt, now)) : 0;

    result.push({
      id: cp.id,
      name: cp.name,
      phone: cp.phone,
      debt,
      total_nasiya: totals.nas,
      total_repaid: totals.repaid,
      debt_days: debtDays,
      oldest_unpaid_at: totals.oldestNasAt ? totals.oldestNasAt.toISOString() : null,
    });
  }

  result.sort((a, b) => b.debt - a.debt || b.debt_days - a.debt_days);
  return result;
}

export function computeTodayDashboard(params: {
  ops: OpRow[];
  obligations: ObligationRow[];
  business: BusinessRow | null;
  counterparties: CounterpartyRow[];
  now?: Date;
  lang?: SupportedLang;
}): TodayDashboard {
  const now = params.now ?? new Date();
  const lang = params.lang ?? 'uz';
  const activeOps = params.ops.filter((o) => o.deletedAt === null);

  const balances = computeCashBalances(activeOps);

  const currMonthStart = startOfTashkentMonth(now, 0);
  const nextMonthStart = startOfTashkentMonth(now, 1);
  const prevMonthStart = startOfTashkentMonth(now, -1);

  const currentMonth = computeMonthSummary(activeOps, currMonthStart, nextMonthStart);
  const previousMonth = computeMonthSummary(activeOps, prevMonthStart, currMonthStart);

  // Annual turnover in current calendar year (Asia/Tashkent) for tax threshold calculation
  const { year } = getTashkentParts(now);
  const yearStart = fromTashkent(year, 1, 1, 0, 0, 0).getTime();
  let ytdSales = 0;
  for (const op of activeOps) {
    if (op.kind === 'sale' && op.occurredAt.getTime() >= yearStart) {
      ytdSales += toSafeInt(op.amount);
    }
  }

  const taxCalc = computeMonthlyTaxAmount({
    monthlyTurnover: currentMonth.sales,
    annualTurnover: Math.max(ytdSales, currentMonth.sales),
    monthlyExpenses: currentMonth.buys + currentMonth.expenses + currentMonth.supplier_payments,
    status: params.business?.status ?? 'yatt',
    regime: params.business?.regime ?? 'turnover',
  });

  const upcomingRaw = computeUpcomingObligations(params.obligations, now);
  const obligationsTotal = upcomingRaw.total + taxCalc.tax;
  const reserve = toSafeInt(params.business?.reserve ?? 0);
  const free = balances.cash - obligationsTotal - reserve;
  const profit3m = computeProfit3m(activeOps, now);

  const debtors = computeDebtorsSummary(activeOps, params.counterparties, now);
  const owedToMe = debtors.reduce((acc, d) => acc + d.debt, 0);

  // 30-day cashflow forecast using scheduled obligations + tax at month-end
  const todayStart = startOfTashkentDay(now);
  const outflowByDate = new Map<string, number>();
  for (const u of upcomingRaw.items) {
    outflowByDate.set(u.due_date, (outflowByDate.get(u.due_date) ?? 0) + u.amount);
  }
  const monthEndDate = toTashkentDateString(addDays(nextMonthStart, -1));
  if (taxCalc.tax > 0) {
    outflowByDate.set(monthEndDate, (outflowByDate.get(monthEndDate) ?? 0) + taxCalc.tax);
  }

  const forecast: ForecastDay[] = [];
  let runningCash = balances.cash;
  for (let d = 0; d < 30; d++) {
    const dayDate = addDays(todayStart, d);
    const key = toTashkentDateString(dayDate);
    const scheduledOutflow = outflowByDate.get(key) ?? 0;
    runningCash -= scheduledOutflow;
    forecast.push({
      date: key,
      projected_cash: runningCash,
      scheduled_outflow: scheduledOutflow,
      cash_gap: runningCash - reserve < 0,
    });
  }

  // Attention alerts
  const attention: AttentionItem[] = [];
  if (free < 0) {
    attention.push({
      code: 'negative_free_cash',
      severity: 'critical',
      title:
        lang === 'ru'
          ? 'Свободных денег не хватает на ближайшие обязательства и резерв'
          : "Yaqin to'lovlar va zaxira uchun bo'sh pul yetmayapti",
      amount: Math.abs(free),
    });
  }

  const overdueDebtors = debtors.filter((d) => d.debt_days >= 14);
  if (overdueDebtors.length > 0) {
    const overdueTotal = overdueDebtors.reduce((acc, d) => acc + d.debt, 0);
    attention.push({
      code: 'overdue_nasiya',
      severity: 'warning',
      title:
        lang === 'ru'
          ? `Просроченная насия (>14 дней): ${overdueDebtors.length} клиент(а)`
          : `14 kundan oshgan nasiya qarzlari: ${overdueDebtors.length} ta mijoz`,
      amount: overdueTotal,
    });
  }

  const imminent = upcomingRaw.items.filter((u) => u.days_until <= 5);
  if (imminent.length > 0) {
    const imminentTotal = imminent.reduce((acc, i) => acc + i.amount, 0);
    attention.push({
      code: 'upcoming_obligation',
      severity: 'info',
      title:
        lang === 'ru'
          ? `Ближайшие платежи в течение 5 дней: ${imminent.length}`
          : `Yaqin 5 kun ichida to'lovlar: ${imminent.length} ta`,
      amount: imminentTotal,
    });
  }

  const salesDeltaPct =
    previousMonth.sales > 0
      ? Number((((currentMonth.sales - previousMonth.sales) / previousMonth.sales) * 100).toFixed(1))
      : null;
  const profitDeltaPct =
    previousMonth.profit !== 0
      ? Number(
          (
            ((currentMonth.profit - previousMonth.profit) / Math.abs(previousMonth.profit)) *
            100
          ).toFixed(1),
        )
      : null;

  return {
    view: {
      cash: balances.cash,
      naqd: balances.naqd,
      karta: balances.karta,
      tax: taxCalc.tax,
      obligations: obligationsTotal,
      reserve,
      free,
      profit: currentMonth.profit,
      profit_3m: profit3m,
      margin: currentMonth.margin,
      owed_to_me: owedToMe,
    },
    upcoming: upcomingRaw.items,
    attention,
    forecast,
    month: {
      current: currentMonth,
      previous: previousMonth,
      sales_delta_pct: salesDeltaPct,
      profit_delta_pct: profitDeltaPct,
    },
  };
}
