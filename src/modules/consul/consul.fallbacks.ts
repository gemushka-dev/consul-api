import type { SupportedLang } from '../../types/express.d.js';
import { formatMoney } from '../../utils/money.js';
import {
  calculateLoan,
  calculateSafeLoan,
  calculateTax,
} from '../calculators/calculators.engine.js';
import { listDebtors } from '../ledger/debtors.service.js';
import { loadUserTodayDashboard } from '../ledger/ops.service.js';
import { extractAmountUzs, parseOperationDeterministic } from '../parser/parser.engine.js';
import type { PendingOpDraft, ToolCallTrace } from './consul.tools.js';
import type { ConsulReplyCard } from './verifyNumbers.js';

export interface DeterministicFallbackResult {
  text: string;
  card: ConsulReplyCard | null;
  pending_op: PendingOpDraft | null;
  tool_calls: ToolCallTrace[];
}

function extractMonthsFromText(text: string): number {
  const m = text.match(/(\d{1,2})\s*(oy|мес|месяц|month)/i);
  if (m && m[1]) {
    const val = Number(m[1]);
    if (val >= 1 && val <= 60) return val;
  }
  const y = text.match(/(\d)\s*(yil|год|лет|year)/i);
  if (y && y[1]) return Number(y[1]) * 12;
  return 24;
}

function extractRateFromText(text: string): number {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(%|foiz|процент)/i);
  if (m && m[1]) {
    const val = Number(m[1].replace(',', '.'));
    if (val >= 0 && val <= 100) return val;
  }
  return 24;
}

/**
 * Deterministic grounded fallback templates used whenever the LLM is unavailable,
 * times out (>8s), or fails verifyNumbers() grounding validation.
 */
export async function buildDeterministicFallback(params: {
  userId: string;
  text: string;
  route?: string;
  lang: SupportedLang;
}): Promise<DeterministicFallbackResult> {
  const { userId, text, route, lang } = params;
  const lower = text.toLowerCase();
  const traces: ToolCallTrace[] = [];

  // 1. Loan / credit query
  if (route === 'loan' || /(kredit|кредит|qarz\s+ol|ссуд|займ)/i.test(lower)) {
    const today = await loadUserTodayDashboard(userId, lang);
    traces.push({ name: 'get_today', args: {}, output: today.view });

    const principal = extractAmountUzs(text) ?? 34_000_000;
    const annualRate = extractRateFromText(text);
    const months = extractMonthsFromText(text);

    const loan = calculateLoan({ principal, annual_rate: annualRate, months, kind: 'annuity' });
    const safe = calculateSafeLoan({
      profit_3m: today.view.profit_3m,
      annual_rate: annualRate,
      months,
      requested_principal: principal,
    });
    traces.push({ name: 'calculate_loan', args: { principal, annual_rate: annualRate, months }, output: loan });
    traces.push({ name: 'safe_loan', args: { annual_rate: annualRate, months, requested_principal: principal }, output: safe });

    const verdictTextUz =
      safe.verdict === 'safe'
        ? "xavfsiz doirada (oylik foydaning 35% dan oshmaydi)"
        : safe.verdict === 'caution'
          ? "ehtiyotkorlik talab qiladi"
          : "xavfli darajada yuqori";
    const verdictTextRu =
      safe.verdict === 'safe'
        ? 'в безопасных пределах (не превышает 35% средней прибыли)'
        : safe.verdict === 'caution'
          ? 'требует осторожности'
          : 'слишком высокая нагрузка';

    const replyText =
      lang === 'ru'
        ? `Кредит ${formatMoney(principal)} сум под ${annualRate}% на ${months} мес.: ежемесячный платёж составит ${formatMoney(loan.monthly_payment)} сум. При вашей средней прибыли за 3 месяца ${formatMoney(today.view.profit_3m)} сум нагрузка составляет ${safe.debt_to_profit_pct}% — это ${verdictTextRu}. Свободных денег сейчас: ${formatMoney(today.view.free)} сум.`
        : `${formatMoney(principal)} so'm kredit (${annualRate}%, ${months} oy) uchun oylik to'lov ${formatMoney(loan.monthly_payment)} so'm bo'ladi. Oxirgi 3 oylik o'rtacha foydangiz ${formatMoney(today.view.profit_3m)} so'm bo'lgani uchun yuklama ${safe.debt_to_profit_pct}% — bu ${verdictTextUz}. Hozir bo'sh pul: ${formatMoney(today.view.free)} so'm.`;

    return {
      text: replyText,
      card: {
        title: lang === 'ru' ? 'Расчёт кредита' : 'Kredit hisob-kitobi',
        value: `${formatMoney(loan.monthly_payment)} ${lang === 'ru' ? 'сум/мес' : "so'm/oy"}`,
        rows: [
          { label: lang === 'ru' ? 'Сумма кредита' : 'Kredit summasi', value: formatMoney(principal) },
          { label: lang === 'ru' ? 'Переплата' : 'Foiz to‘lovi', value: formatMoney(loan.total_interest) },
          { label: lang === 'ru' ? 'Средняя прибыль (3 мес.)' : "O'rtacha foyda (3 oy)", value: formatMoney(today.view.profit_3m) },
          { label: lang === 'ru' ? 'Макс. безопасный платёж' : "Maks. xavfsiz to'lov", value: formatMoney(safe.max_safe_monthly_payment) },
        ],
      },
      pending_op: null,
      tool_calls: traces,
    };
  }

  // 2. Tax query
  if (route === 'tax' || /(soliq|налог|qqs|ндс|yatt|самозан)/i.test(lower)) {
    const today = await loadUserTodayDashboard(userId, lang);
    const monthlyTurnover = extractAmountUzs(text) ?? Math.max(today.month.current.sales, 50_000_000);
    const taxRes = calculateTax({ monthly_turnover: monthlyTurnover, status: 'yatt', regime: 'turnover' });
    traces.push({ name: 'get_today', args: {}, output: today.view });
    traces.push({ name: 'calculate_tax', args: { monthly_turnover: monthlyTurnover }, output: taxRes });

    const replyText =
      lang === 'ru'
        ? `При месячном обороте ${formatMoney(monthlyTurnover)} сум ставка составляет ${taxRes.effective_rate_pct}%, налог за месяц — ${formatMoney(taxRes.monthly_tax)} сум (в год ${formatMoney(taxRes.annual_tax)} сум). Текущий налог к отложению в этом месяце: ${formatMoney(today.view.tax)} сум.`
        : `Oylik aylanma ${formatMoney(monthlyTurnover)} so'm bo'lganda soliq stavkasi ${taxRes.effective_rate_pct}%, oylik soliq ${formatMoney(taxRes.monthly_tax)} so'm (yillik ${formatMoney(taxRes.annual_tax)} so'm). Joriy oydagi soliq: ${formatMoney(today.view.tax)} so'm.`;

    return {
      text: replyText,
      card: {
        title: lang === 'ru' ? 'Налоговый расчёт (2026)' : 'Soliq hisobi (2026)',
        value: `${formatMoney(taxRes.monthly_tax)} ${lang === 'ru' ? 'сум/мес' : "so'm/oy"}`,
        rows: [
          { label: lang === 'ru' ? 'Оборот/мес' : 'Oylik aylanma', value: formatMoney(monthlyTurnover) },
          { label: lang === 'ru' ? 'Ставка' : 'Stavka', value: `${taxRes.effective_rate_pct}%` },
          { label: lang === 'ru' ? 'Годовой налог' : 'Yillik soliq', value: formatMoney(taxRes.annual_tax) },
        ],
      },
      pending_op: null,
      tool_calls: traces,
    };
  }

  // 3. Debtors / nasiya query
  if (route === 'debtors' || /(qarzdor|nasiya|должник|кто должен|насия)/i.test(lower)) {
    const debtors = await listDebtors(userId);
    traces.push({ name: 'list_debtors', args: {}, output: { count: debtors.items.length, total_owed: debtors.total_owed } });

    const replyText =
      lang === 'ru'
        ? `Всего вам должны ${formatMoney(debtors.total_owed)} сум (${debtors.items.length} клиент(ов)).`
        : `Sizga jami ${formatMoney(debtors.total_owed)} so'm nasiya qarzi bor (${debtors.items.length} ta mijoz).`;

    return {
      text: replyText,
      card: {
        title: lang === 'ru' ? 'Должники по насии' : 'Nasiya qarzdorlari',
        value: `${formatMoney(debtors.total_owed)} ${lang === 'ru' ? 'сум' : "so'm"}`,
        rows: debtors.items.slice(0, 5).map((d) => ({
          label: `${d.name} (${d.debt_days} d)`,
          value: formatMoney(d.debt),
        })),
      },
      pending_op: null,
      tool_calls: traces,
    };
  }

  // 4. Operation draft intent
  const parsed = parseOperationDeterministic(text);
  if (parsed.intent === 'op' && parsed.draft) {
    traces.push({ name: 'draft_operation', args: parsed.draft as unknown as Record<string, unknown>, output: parsed.draft });
    const draft = parsed.draft;
    const replyText =
      lang === 'ru'
        ? `Подготовил черновик операции (${draft.kind}): ${formatMoney(draft.amount)} сум (${draft.method}). Нажмите «Подтвердить», чтобы записать в журнал.`
        : `Operatsiya qoralamasi tayyor (${draft.kind}): ${formatMoney(draft.amount)} so'm (${draft.method}). Jurnalga yozish uchun «Tasdiqlash» tugmasini bosing.`;

    return {
      text: replyText,
      card: {
        title: lang === 'ru' ? 'Черновик операции' : 'Operatsiya qoralamasi',
        value: `${formatMoney(draft.amount)} ${lang === 'ru' ? 'сум' : "so'm"}`,
        rows: [
          { label: lang === 'ru' ? 'Тип' : 'Turi', value: draft.kind },
          { label: lang === 'ru' ? 'Способ' : 'Usul', value: draft.method },
        ],
      },
      pending_op: draft as PendingOpDraft,
      tool_calls: traces,
    };
  }

  // 5. Default: Today summary
  const today = await loadUserTodayDashboard(userId, lang);
  traces.push({ name: 'get_today', args: {}, output: today.view });

  const replyText =
    lang === 'ru'
      ? `На сегодня у вас всего ${formatMoney(today.view.cash)} сум (наличные ${formatMoney(today.view.naqd)}, карта ${formatMoney(today.view.karta)}). Ближайшие обязательства с налогом: ${formatMoney(today.view.obligations)} сум, резерв: ${formatMoney(today.view.reserve)} сум. Можно безопасно потратить: ${formatMoney(today.view.free)} сум.`
      : `Bugungi holat: jami pul ${formatMoney(today.view.cash)} so'm (naqd ${formatMoney(today.view.naqd)}, karta ${formatMoney(today.view.karta)}). Yaqin majburiyatlar va soliq: ${formatMoney(today.view.obligations)} so'm, zaxira: ${formatMoney(today.view.reserve)} so'm. Bemalol sarflash mumkin: ${formatMoney(today.view.free)} so'm.`;

  return {
    text: replyText,
    card: {
      title: lang === 'ru' ? 'Можно потратить' : 'Sarflash mumkin',
      value: `${formatMoney(today.view.free)} ${lang === 'ru' ? 'сум' : "so'm"}`,
      rows: [
        { label: lang === 'ru' ? 'Всего денег' : 'Jami pul', value: formatMoney(today.view.cash) },
        { label: lang === 'ru' ? 'Обязательства + налог' : 'Majburiyat + soliq', value: formatMoney(today.view.obligations) },
        { label: lang === 'ru' ? 'Резерв' : 'Zaxira', value: formatMoney(today.view.reserve) },
      ],
    },
    pending_op: null,
    tool_calls: traces,
  };
}
