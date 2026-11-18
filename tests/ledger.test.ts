import { describe, expect, it } from 'vitest';
import type { BusinessRow, CounterpartyRow, ObligationRow, OpRow } from '../src/db/schema.js';
import { computeTodayDashboard } from '../src/modules/ledger/ledger.math.js';
import { fromTashkent } from '../src/utils/time.js';

function makeOp(partial: Partial<OpRow> & Pick<OpRow, 'kind' | 'amount' | 'method' | 'occurredAt'>): OpRow {
  return {
    id: crypto.randomUUID(),
    userId: '00000000-0000-0000-0000-000000000001',
    label: null,
    counterpartyId: null,
    fiscal: false,
    source: 'manual',
    rawText: null,
    items: null,
    deletedAt: null,
    idempotencyKey: null,
    ...partial,
  };
}

describe('Ledger Dashboard Calculations (Dilnoza Benchmark)', () => {
  const now = fromTashkent(2026, 11, 18, 12, 0, 0);
  const business: BusinessRow = {
    userId: '00000000-0000-0000-0000-000000000001',
    trade: 'Quritilgan mevalar',
    sector: 'dried_fruit',
    market: 'chorsu',
    status: 'yatt',
    regime: 'turnover',
    reserve: 1_200_000,
    updatedAt: now,
  };

  const customerId = '00000000-0000-0000-0000-000000000099';
  const counterparties: CounterpartyRow[] = [
    {
      id: customerId,
      userId: business.userId,
      name: 'Akmal',
      kind: 'customer',
      phone: '+998901112233',
      createdAt: fromTashkent(2026, 10, 1),
    },
  ];

  const obligations: ObligationRow[] = [
    {
      id: '00000000-0000-0000-0000-000000000010',
      userId: business.userId,
      kind: 'rent',
      title: 'Chorsu rasta ijarasi',
      amount: 3_000_000,
      dueDay: 25,
      dueDate: null,
      recurring: true,
      counterpartyId: null,
    },
    {
      id: '00000000-0000-0000-0000-000000000011',
      userId: business.userId,
      kind: 'supplier',
      title: "Samarkand mayiz ta'minotchisi",
      amount: 3_100_000,
      dueDay: 28,
      dueDate: null,
      recurring: true,
      counterpartyId: null,
    },
  ];

  it('produces exact Dilnoza reference numbers: cash=12M, obligations=6.6M, reserve=1.2M => free=4.2M', () => {
    const ops: OpRow[] = [
      // Previous 3 closed months (Aug, Sep, Oct) with 6M net profit each -> profit_3m = 6M
      makeOp({ kind: 'sale', amount: 46_000_000, method: 'naqd', occurredAt: fromTashkent(2026, 8, 15) }),
      makeOp({ kind: 'buy', amount: 40_000_000, method: 'naqd', occurredAt: fromTashkent(2026, 8, 16) }),
      makeOp({ kind: 'sale', amount: 48_000_000, method: 'karta', occurredAt: fromTashkent(2026, 9, 15) }),
      makeOp({ kind: 'buy', amount: 42_000_000, method: 'karta', occurredAt: fromTashkent(2026, 9, 16) }),
      makeOp({ kind: 'sale', amount: 50_000_000, method: 'karta', occurredAt: fromTashkent(2026, 10, 15) }),
      makeOp({ kind: 'buy', amount: 44_000_000, method: 'karta', occurredAt: fromTashkent(2026, 10, 16) }),
      // Adjust opening balances so total cash = 12,000,000 (naqd=4,800,000, karta=7,200,000)
      makeOp({ kind: 'exp', amount: 11_200_000, method: 'naqd', occurredAt: fromTashkent(2026, 10, 20) }),
      makeOp({ kind: 'exp', amount: 14_800_000, method: 'karta', occurredAt: fromTashkent(2026, 10, 20) }),
      // Current month (Nov 2026): 50M sales -> 1% tax = 500,000; 40M costs -> net +10M naqd, +10M karta
      makeOp({ kind: 'sale', amount: 25_000_000, method: 'naqd', occurredAt: fromTashkent(2026, 11, 5) }),
      makeOp({ kind: 'buy', amount: 15_000_000, method: 'naqd', occurredAt: fromTashkent(2026, 11, 6) }),
      makeOp({ kind: 'sale', amount: 25_000_000, method: 'karta', occurredAt: fromTashkent(2026, 11, 10) }),
      makeOp({ kind: 'buy', amount: 15_000_000, method: 'karta', occurredAt: fromTashkent(2026, 11, 11) }),
      // Nasiya does NOT affect cash
      makeOp({
        kind: 'nas',
        amount: 2_500_000,
        method: 'none',
        counterpartyId: customerId,
        occurredAt: fromTashkent(2026, 11, 1),
      }),
      // Soft-deleted op must be ignored
      makeOp({
        kind: 'sale',
        amount: 99_000_000,
        method: 'naqd',
        occurredAt: fromTashkent(2026, 11, 12),
        deletedAt: fromTashkent(2026, 11, 12, 1),
      }),
    ];

    const res = computeTodayDashboard({ ops, obligations, business, counterparties, now, lang: 'ru' });

    expect(res.view.naqd).toBe(4_800_000);
    expect(res.view.karta).toBe(7_200_000);
    expect(res.view.cash).toBe(12_000_000);
    expect(res.view.tax).toBe(500_000);
    expect(res.view.obligations).toBe(6_600_000);
    expect(res.view.reserve).toBe(1_200_000);
    expect(res.view.free).toBe(4_200_000);
    expect(res.view.owed_to_me).toBe(2_500_000);
    expect(res.forecast).toHaveLength(30);
    expect(res.attention.some((a) => a.code === 'overdue_nasiya')).toBe(true);
  });

  it('applies signed fix delta correctly', () => {
    const ops: OpRow[] = [
      makeOp({ kind: 'opening', amount: 5_000_000, method: 'naqd', occurredAt: fromTashkent(2026, 11, 1) }),
      makeOp({ kind: 'fix', amount: -300_000, method: 'naqd', occurredAt: fromTashkent(2026, 11, 10) }),
    ];
    const res = computeTodayDashboard({ ops, obligations: [], business: null, counterparties: [], now });
    expect(res.view.cash).toBe(4_700_000);
    expect(res.view.naqd).toBe(4_700_000);
  });
});
