import { describe, expect, it } from 'vitest';
import {
  calculateBreakeven,
  calculateLoan,
  calculateSafeLoan,
  calculateTax,
  UZ_TAX_RULES,
} from '../src/modules/calculators/calculators.engine.js';

describe('Uzbekistan 2026 Tax Rules & Deterministic Calculators', () => {
  it('loads 2026 tax rules with 100M, 1B, and 12,000 BRV thresholds', () => {
    expect(UZ_TAX_RULES.year).toBe(2026);
    expect(UZ_TAX_RULES.thresholds.self_employed_zero_annual).toBe(100_000_000);
    expect(UZ_TAX_RULES.thresholds.turnover_1pct_annual).toBe(1_000_000_000);
    expect(UZ_TAX_RULES.thresholds.vat_mandatory_brv).toBe(12_000);
    expect(UZ_TAX_RULES.thresholds.vat_mandatory_annual).toBe(4_944_000_000);
  });

  it('matches Dilnoza benchmark loan: 34,000,000 UZS @ 24% for 24 months = 1,797,617 UZS/mo', () => {
    const res = calculateLoan({
      principal: 34_000_000,
      annual_rate: 24,
      months: 24,
      kind: 'annuity',
    });

    expect(res.monthly_payment).toBe(1_797_617);
    expect(res.schedule).toHaveLength(24);
    expect(res.schedule[23]?.remaining_balance).toBe(0);
    expect(res.total_interest).toBeGreaterThan(9_000_000);
  });

  it('computes differentiated loan schedule accurately', () => {
    const res = calculateLoan({
      principal: 12_000_000,
      annual_rate: 24,
      months: 12,
      kind: 'differentiated',
    });

    expect(res.first_month_payment).toBe(1_240_000);
    expect(res.last_month_payment).toBe(1_020_000);
    expect(res.schedule[11]?.remaining_balance).toBe(0);
  });

  it('applies 0% tax for self-employed under 100M, 1% for YATT under 1B, 4% above 1B, VAT12 above 12k BRV', () => {
    const oob = calculateTax({ monthly_turnover: 8_000_000, status: 'oob', regime: 'turnover' });
    expect(oob.effective_rate_pct).toBe(0);
    expect(oob.monthly_tax).toBe(0);

    // Dilnoza: 50M monthly turnover (600M annual < 1B) -> 1% = 500,000 UZS
    const yatt = calculateTax({ monthly_turnover: 50_000_000, status: 'yatt', regime: 'turnover' });
    expect(yatt.effective_rate_pct).toBe(1);
    expect(yatt.monthly_tax).toBe(500_000);

    const over1b = calculateTax({
      monthly_turnover: 100_000_000,
      status: 'yatt',
      regime: 'turnover',
    });
    expect(over1b.effective_rate_pct).toBe(4);
    expect(over1b.monthly_tax).toBe(4_000_000);

    const vat = calculateTax({
      monthly_turnover: 500_000_000,
      monthly_expenses: 400_000_000,
      status: 'mchj',
      regime: 'turnover',
    });
    expect(vat.monthly_tax).toBe(75_000_000); // 60M VAT + 15M profit tax
  });

  it('computes breakeven, payback, and ROI', () => {
    const res = calculateBreakeven({
      fixed_costs: 6_000_000,
      unit_price: 50_000,
      unit_cost: 30_000,
      investment: 20_000_000,
      expected_monthly_units: 500,
    });

    expect(res.contribution_margin).toBe(20_000);
    expect(res.breakeven_units).toBe(300);
    expect(res.breakeven_revenue).toBe(15_000_000);
    expect(res.expected_monthly_profit).toBe(4_000_000);
    expect(res.payback_months).toBe(5);
    expect(res.roi_annual_pct).toBe(240);
  });

  it('evaluates safe loan limit based on 3-month average profit', () => {
    const res = calculateSafeLoan({
      profit_3m: 6_000_000,
      annual_rate: 24,
      months: 24,
      requested_principal: 34_000_000,
    });

    // 35% of 6,000,000 = 2,100,000 >= 1,797,617 -> safe
    expect(res.max_safe_monthly_payment).toBe(2_100_000);
    expect(res.requested_monthly_payment).toBe(1_797_617);
    expect(res.verdict).toBe('safe');
  });
});
