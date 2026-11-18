import { describe, expect, it } from 'vitest';
import {
  extractAmountUzs,
  parseOperationDeterministic,
} from '../src/modules/parser/parser.engine.js';

describe('UZ/RU Deterministic Intent & Operation Parser', () => {
  it('extracts UZS amounts with mln, ming, mlrd, тыс, k, and spaced formats', () => {
    expect(extractAmountUzs('bugun 1,2 mln sotdim')).toBe(1_200_000);
    expect(extractAmountUzs('500 ming xarajat')).toBe(500_000);
    expect(extractAmountUzs('продал на 350 тыс картой')).toBe(350_000);
    expect(extractAmountUzs('1.5 млрд sotdim')).toBe(1_500_000_000);
    expect(extractAmountUzs('купил товар 2 450 000')).toBe(2_450_000);
    expect(extractAmountUzs('250k')).toBe(250_000);
  });

  it('parses Uzbek sale phrase "bugun 1,2 mln sotdim" deterministically without LLM', () => {
    const res = parseOperationDeterministic('bugun 1,2 mln sotdim');
    expect(res.source).toBe('deterministic');
    expect(res.intent).toBe('op');
    expect(res.confirm).toBe(false);
    expect(res.draft).toMatchObject({
      kind: 'sale',
      amount: 1_200_000,
      method: 'naqd',
    });
  });

  it('parses Russian card purchase and nasiya with debtor name', () => {
    const buy = parseOperationDeterministic('купил орехи 800 тыс картой');
    expect(buy.intent).toBe('op');
    expect(buy.draft).toMatchObject({
      kind: 'buy',
      amount: 800_000,
      method: 'karta',
    });

    const nas = parseOperationDeterministic('Akmalga 400 ming nasiya');
    expect(nas.intent).toBe('op');
    expect(nas.draft).toMatchObject({
      kind: 'nas',
      amount: 400_000,
      method: 'none',
      counterparty_name: 'Akmal',
    });
  });

  it('recognizes fix, rent, question, report, need-amount, need-kind, and unknown', () => {
    expect(parseOperationDeterministic('kassada 4,8 mln qoldiq').intent).toBe('fix');
    expect(parseOperationDeterministic('ijara 3 mln toladim').intent).toBe('rent');
    expect(parseOperationDeterministic('34 mln kredit olsam bo\'ladimi?').intent).toBe('question');
    expect(parseOperationDeterministic('bank uchun hisobot kerak').intent).toBe('report');
    expect(parseOperationDeterministic('bugun sotdim').intent).toBe('need-amount');
    expect(parseOperationDeterministic('500 ming').intent).toBe('need-kind');
    expect(parseOperationDeterministic('salom do\'stim').intent).toBe('unknown');
  });

  it('sets confirm=true when amount >= 1,000,000,000 UZS', () => {
    const huge = parseOperationDeterministic('bugun 1,2 mlrd sotdim');
    expect(huge.intent).toBe('op');
    expect(huge.draft?.amount).toBe(1_200_000_000);
    expect(huge.confirm).toBe(true);
    expect(huge.confirm_reason).toBe('large_amount');
  });
});
