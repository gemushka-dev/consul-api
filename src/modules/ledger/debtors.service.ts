import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/db.js';
import { counterparties, ops } from '../../db/schema.js';
import type { SupportedLang } from '../../types/express.d.js';
import { Errors } from '../../utils/errors.js';
import { formatMoney } from '../../utils/money.js';
import { computeDebtorsSummary, type DebtorSummary } from './ledger.math.js';
import { createOperation } from './ops.service.js';

export async function listDebtors(userId: string): Promise<{
  items: DebtorSummary[];
  total_owed: number;
}> {
  const db = getDb();
  const [opRows, cpRows] = await Promise.all([
    db.select().from(ops).where(and(eq(ops.userId, userId), isNull(ops.deletedAt))),
    db.select().from(counterparties).where(eq(counterparties.userId, userId)),
  ]);

  const items = computeDebtorsSummary(opRows, cpRows);
  const totalOwed = items.reduce((acc, d) => acc + d.debt, 0);
  return { items, total_owed: totalOwed };
}

export async function recordDebtorRepayment(
  userId: string,
  debtorId: string,
  input: { amount?: number; method: 'naqd' | 'karta' },
  lang: SupportedLang = 'uz',
) {
  const { items } = await listDebtors(userId);
  const debtor = items.find((d) => d.id === debtorId);
  if (!debtor) {
    throw Errors.notFound('debtor_not_found', 'Active debtor with positive balance not found');
  }

  const repayAmount = input.amount ? Math.min(input.amount, debtor.debt) : debtor.debt;
  if (repayAmount <= 0) {
    throw Errors.badRequest('invalid_amount', 'Repayment amount must be positive', 'amount');
  }

  const created = await createOperation(
    userId,
    {
      kind: 'repaid',
      amount: repayAmount,
      method: input.method,
      counterparty_id: debtorId,
      label: `${debtor.name} (nasiya to'lovi)`,
      fiscal: false,
      source: 'manual',
    },
    undefined,
    lang,
  );

  return {
    op: created.op,
    debtor_id: debtorId,
    debtor_name: debtor.name,
    repaid_amount: repayAmount,
    remaining_debt: Math.max(0, debtor.debt - repayAmount),
    free_before: created.free_before,
    free_after: created.free_after,
  };
}

export async function generateDebtReminder(
  userId: string,
  debtorId: string,
  lang: SupportedLang = 'uz',
) {
  const { items } = await listDebtors(userId);
  const debtor = items.find((d) => d.id === debtorId);
  if (!debtor) {
    throw Errors.notFound('debtor_not_found', 'Active debtor with positive balance not found');
  }

  const formattedAmount = formatMoney(debtor.debt);
  let text: string;

  if (lang === 'ru') {
    text = `Здравствуйте, ${debtor.name}! Напоминаю о сумме по насии: ${formattedAmount} сум (${debtor.debt_days} дн.). Буду признателен(а) за оплату в удобное для вас время. Спасибо!`;
  } else if (lang === 'en') {
    text = `Hello ${debtor.name}! Friendly reminder regarding your open balance of ${formattedAmount} UZS (${debtor.debt_days} days). Thank you for settling it at your convenience.`;
  } else {
    text = `Assalomu alaykum, ${debtor.name}! Sizning nasiya qarzingiz ${formattedAmount} so'm (${debtor.debt_days} kun) bo'lib turibdi. Imkoningiz bo'lganda to'lab qo'ysangiz xursand bo'lardim. Rahmat!`;
  }

  return {
    debtor_id: debtor.id,
    debtor_name: debtor.name,
    phone: debtor.phone,
    amount: debtor.debt,
    debt_days: debtor.debt_days,
    lang,
    text,
  };
}
