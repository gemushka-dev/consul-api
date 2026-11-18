import { describe, expect, it } from 'vitest';
import { unmaskPiiText } from '../src/modules/consul/consul.tools.js';
import { verifyNumbers } from '../src/modules/consul/verifyNumbers.js';

describe('Consul Grounding Check (verifyNumbers) & PII Masking', () => {
  it('passes when all figures in reply text and card match tool outputs', () => {
    const toolOutputs = [
      {
        view: {
          cash: 12_000_000,
          obligations: 6_600_000,
          reserve: 1_200_000,
          free: 4_200_000,
          profit_3m: 6_000_000,
        },
      },
      {
        monthly_payment: 1_797_617,
        debt_to_profit_pct: 30,
      },
    ];

    const check = verifyNumbers(
      {
        text: 'Можно потратить 4 200 000 сум (4,2 млн). Платёж по кредиту 34 млн под 24% на 24 мес составит 1 797 617 сум.',
        card: {
          title: 'Кредит',
          value: '1 797 617 сум/мес',
          rows: [{ label: 'Свободные деньги', value: '4 200 000' }],
        },
      },
      toolOutputs,
      '34 mln kredit 24% 24 oy',
    );

    expect(check.ok).toBe(true);
    expect(check.ungrounded).toEqual([]);
  });

  it('rejects hallucinated numbers in reply text or card rows', () => {
    const toolOutputs = [{ view: { cash: 12_000_000, free: 4_200_000 } }];

    const check = verifyNumbers(
      {
        text: 'У вас сейчас 15 500 000 сум свободных денег.',
        card: {
          title: 'Баланс',
          value: '15 500 000',
          rows: [{ label: 'Налог', value: '999 000' }],
        },
      },
      toolOutputs,
      'сколько у меня денег?',
    );

    expect(check.ok).toBe(false);
    expect(check.ungrounded).toContain(15_500_000);
    expect(check.ungrounded).toContain(999_000);
  });

  it('unmasks PII debtor codes D1/D2 cleanly after LLM generation', () => {
    const map = new Map([
      ['D1', 'Akmal'],
      ['D2', 'Sardor'],
    ]);
    const unmasked = unmaskPiiText('D1 owes 1 400 000 and D2 owes 950 000.', map);
    expect(unmasked).toBe('Akmal owes 1 400 000 and Sardor owes 950 000.');
  });
});
