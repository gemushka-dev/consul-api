import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidateRulePaths = [
  path.join(process.cwd(), 'config/uz_tax_2026.json'),
  path.resolve(__dirname, '../../../config/uz_tax_2026.json'),
];
const rulesPath = candidateRulePaths.find((p) => fs.existsSync(p));

export interface TaxRulesConfig {
  year: number;
  currency: string;
  brv: number;
  thresholds: {
    self_employed_zero_annual: number;
    turnover_1pct_annual: number;
    vat_mandatory_brv: number;
    vat_mandatory_annual: number;
  };
  rates: {
    self_employed_under_100m: number;
    turnover_under_1b: number;
    turnover_over_1b: number;
    vat_reduced: number;
    vat_standard: number;
    profit_tax_standard: number;
    social_tax_yatt_monthly_brv: number;
  };
  regimes: Array<Record<string, unknown>>;
  sources: Array<{ title: string; url: string }>;
}

export const UZ_TAX_RULES: TaxRulesConfig = rulesPath
  ? (JSON.parse(fs.readFileSync(rulesPath, 'utf-8')) as TaxRulesConfig)
  : {
      year: 2026,
      currency: 'UZS',
      brv: 412000,
      thresholds: {
        self_employed_zero_annual: 100_000_000,
        turnover_1pct_annual: 1_000_000_000,
        vat_mandatory_brv: 12_000,
        vat_mandatory_annual: 4_944_000_000,
      },
      rates: {
        self_employed_under_100m: 0,
        turnover_under_1b: 0.01,
        turnover_over_1b: 0.04,
        vat_reduced: 0.06,
        vat_standard: 0.12,
        profit_tax_standard: 0.15,
        social_tax_yatt_monthly_brv: 1,
      },
      regimes: [],
      sources: [
        { title: 'Lex.uz', url: 'https://lex.uz/docs/4674902' },
        { title: 'Soliq.uz', url: 'https://soliq.uz' },
      ],
    };

export interface LoanInput {
  principal: number;
  annual_rate: number; // percent, e.g. 24
  months: number;
  kind?: 'annuity' | 'differentiated';
}

export interface LoanScheduleRow {
  month: number;
  payment: number;
  principal_part: number;
  interest_part: number;
  remaining_balance: number;
}

export interface LoanResult {
  kind: 'annuity' | 'differentiated';
  principal: number;
  annual_rate: number;
  months: number;
  monthly_payment: number;
  first_month_payment: number;
  last_month_payment: number;
  total_payment: number;
  total_interest: number;
  overpayment_pct: number;
  schedule: LoanScheduleRow[];
}

export function calculateLoan(input: LoanInput): LoanResult {
  const kind = input.kind ?? 'annuity';
  const P = Math.round(input.principal);
  const n = Math.round(input.months);
  const monthlyRate = input.annual_rate / 100 / 12;

  const schedule: LoanScheduleRow[] = [];

  if (kind === 'annuity') {
    let monthlyPayment: number;
    if (monthlyRate === 0) {
      monthlyPayment = Math.round(P / n);
    } else {
      const factor = Math.pow(1 + monthlyRate, n);
      monthlyPayment = Math.round((P * monthlyRate * factor) / (factor - 1));
    }

    let balance = P;
    let totalPayment = 0;
    let totalInterest = 0;

    for (let m = 1; m <= n; m++) {
      const interest = Math.round(balance * monthlyRate);
      let principalPart = monthlyPayment - interest;
      let payment = monthlyPayment;

      if (m === n) {
        principalPart = balance;
        payment = principalPart + interest;
      }

      balance = Math.max(0, balance - principalPart);
      totalPayment += payment;
      totalInterest += interest;

      schedule.push({
        month: m,
        payment,
        principal_part: principalPart,
        interest_part: interest,
        remaining_balance: balance,
      });
    }

    return {
      kind,
      principal: P,
      annual_rate: input.annual_rate,
      months: n,
      monthly_payment: monthlyPayment,
      first_month_payment: schedule[0]?.payment ?? monthlyPayment,
      last_month_payment: schedule[schedule.length - 1]?.payment ?? monthlyPayment,
      total_payment: totalPayment,
      total_interest: totalInterest,
      overpayment_pct: P > 0 ? Number(((totalInterest / P) * 100).toFixed(2)) : 0,
      schedule,
    };
  }

  // Differentiated schedule
  const basePrincipal = Math.floor(P / n);
  let balance = P;
  let totalPayment = 0;
  let totalInterest = 0;

  for (let m = 1; m <= n; m++) {
    const interest = Math.round(balance * monthlyRate);
    const principalPart = m === n ? balance : basePrincipal;
    const payment = principalPart + interest;
    balance = Math.max(0, balance - principalPart);
    totalPayment += payment;
    totalInterest += interest;

    schedule.push({
      month: m,
      payment,
      principal_part: principalPart,
      interest_part: interest,
      remaining_balance: balance,
    });
  }

  return {
    kind,
    principal: P,
    annual_rate: input.annual_rate,
    months: n,
    monthly_payment: Math.round(totalPayment / n),
    first_month_payment: schedule[0]?.payment ?? 0,
    last_month_payment: schedule[schedule.length - 1]?.payment ?? 0,
    total_payment: totalPayment,
    total_interest: totalInterest,
    overpayment_pct: P > 0 ? Number(((totalInterest / P) * 100).toFixed(2)) : 0,
    schedule,
  };
}

export interface TaxInput {
  monthly_turnover: number;
  monthly_expenses?: number;
  status?: 'yatt' | 'oob' | 'mchj' | 'none';
  regime?: 'turnover' | 'vat6' | 'vat12';
  annual_turnover?: number;
}

export interface TaxRegimeComparison {
  regime: string;
  rate_pct: number;
  monthly_tax: number;
  annual_tax: number;
  eligible: boolean;
  reason?: string;
}

export interface TaxResult {
  monthly_turnover: number;
  annual_turnover: number;
  effective_rate_pct: number;
  monthly_tax: number;
  annual_tax: number;
  recommended_regime: string;
  comparisons: TaxRegimeComparison[];
  thresholds: TaxRulesConfig['thresholds'];
}

/**
 * Computes effective monthly tax rate according to Uzbekistan 2026 tax rules:
 * - Self-employed (oob) with annual turnover <= 100M -> 0%
 * - YATT / self-employed / turnover regime up to 1B annual -> 1%
 * - Above 1B up to 12,000 BRV (~4.944B) -> 4%
 * - Above 12,000 BRV or general VAT12 regime -> 12% VAT + 15% profit tax
 */
export function computeMonthlyTaxAmount(params: {
  monthlyTurnover: number;
  annualTurnover?: number;
  monthlyExpenses?: number;
  status?: string;
  regime?: string;
}): { tax: number; ratePct: number; regimeUsed: string } {
  const monthlyTurnover = Math.max(0, Math.round(params.monthlyTurnover));
  const annualTurnover = Math.max(
    monthlyTurnover,
    Math.round(params.annualTurnover ?? monthlyTurnover * 12),
  );
  const monthlyExpenses = Math.max(0, Math.round(params.monthlyExpenses ?? monthlyTurnover * 0.7));
  const status = params.status ?? 'yatt';
  const regime = params.regime ?? 'turnover';
  const { thresholds, rates } = UZ_TAX_RULES;

  if (regime === 'vat12' || annualTurnover > thresholds.vat_mandatory_annual) {
    const vat = Math.round(monthlyTurnover * rates.vat_standard);
    const profit = Math.max(0, monthlyTurnover - monthlyExpenses);
    const profitTax = Math.round(profit * rates.profit_tax_standard);
    const total = vat + profitTax;
    const eff = monthlyTurnover > 0 ? Number(((total / monthlyTurnover) * 100).toFixed(2)) : 12;
    return { tax: total, ratePct: eff, regimeUsed: 'vat12' };
  }

  if (regime === 'vat6') {
    const tax = Math.round(monthlyTurnover * rates.vat_reduced);
    return { tax, ratePct: 6, regimeUsed: 'vat6' };
  }

  if (status === 'oob' && annualTurnover <= thresholds.self_employed_zero_annual) {
    return { tax: 0, ratePct: 0, regimeUsed: 'oob_zero' };
  }

  if (annualTurnover <= thresholds.turnover_1pct_annual) {
    return {
      tax: Math.round(monthlyTurnover * rates.turnover_under_1b),
      ratePct: 1,
      regimeUsed: 'turnover_1',
    };
  }

  return {
    tax: Math.round(monthlyTurnover * rates.turnover_over_1b),
    ratePct: 4,
    regimeUsed: 'turnover_4',
  };
}

export function calculateTax(input: TaxInput): TaxResult {
  const monthlyTurnover = Math.max(0, Math.round(input.monthly_turnover));
  const annualTurnover = Math.round(input.annual_turnover ?? monthlyTurnover * 12);
  const monthlyExpenses = Math.round(input.monthly_expenses ?? monthlyTurnover * 0.7);
  const { thresholds, rates } = UZ_TAX_RULES;

  const current = computeMonthlyTaxAmount({
    monthlyTurnover,
    annualTurnover,
    monthlyExpenses,
    status: input.status,
    regime: input.regime,
  });

  const oobEligible = annualTurnover <= thresholds.self_employed_zero_annual;
  const t1Eligible = annualTurnover <= thresholds.turnover_1pct_annual;
  const t4Eligible = annualTurnover <= thresholds.vat_mandatory_annual;

  const vat12Calc = computeMonthlyTaxAmount({
    monthlyTurnover,
    annualTurnover,
    monthlyExpenses,
    regime: 'vat12',
  });

  const comparisons: TaxRegimeComparison[] = [
    {
      regime: 'oob_zero',
      rate_pct: 0,
      monthly_tax: 0,
      annual_tax: 0,
      eligible: oobEligible,
      ...(oobEligible ? {} : { reason: 'Annual turnover exceeds 100,000,000 UZS' }),
    },
    {
      regime: 'turnover_1',
      rate_pct: 1,
      monthly_tax: Math.round(monthlyTurnover * rates.turnover_under_1b),
      annual_tax: Math.round(annualTurnover * rates.turnover_under_1b),
      eligible: t1Eligible,
      ...(t1Eligible ? {} : { reason: 'Annual turnover exceeds 1,000,000,000 UZS' }),
    },
    {
      regime: 'turnover_4',
      rate_pct: 4,
      monthly_tax: Math.round(monthlyTurnover * rates.turnover_over_1b),
      annual_tax: Math.round(annualTurnover * rates.turnover_over_1b),
      eligible: t4Eligible,
      ...(t4Eligible ? {} : { reason: 'Annual turnover exceeds 12,000 BRV (4,944,000,000 UZS)' }),
    },
    {
      regime: 'vat12',
      rate_pct: vat12Calc.ratePct,
      monthly_tax: vat12Calc.tax,
      annual_tax: vat12Calc.tax * 12,
      eligible: true,
    },
  ];

  const bestEligible = comparisons
    .filter((c) => c.eligible)
    .sort((a, b) => a.monthly_tax - b.monthly_tax)[0];

  return {
    monthly_turnover: monthlyTurnover,
    annual_turnover: annualTurnover,
    effective_rate_pct: current.ratePct,
    monthly_tax: current.tax,
    annual_tax: current.tax * 12,
    recommended_regime: bestEligible?.regime ?? 'vat12',
    comparisons,
    thresholds,
  };
}

export interface BreakevenInput {
  fixed_costs: number;
  unit_price: number;
  unit_cost: number;
  investment?: number;
  expected_monthly_units?: number;
}

export interface BreakevenResult {
  contribution_margin: number;
  margin_pct: number;
  breakeven_units: number;
  breakeven_revenue: number;
  expected_monthly_profit: number | null;
  payback_months: number | null;
  roi_annual_pct: number | null;
}

export function calculateBreakeven(input: BreakevenInput): BreakevenResult {
  const contribution = Math.round(input.unit_price - input.unit_cost);
  if (contribution <= 0) {
    throw new Error('unit_price must be strictly greater than unit_cost');
  }

  const fixedCosts = Math.max(0, Math.round(input.fixed_costs));
  const breakevenUnits = Math.ceil(fixedCosts / contribution);
  const breakevenRevenue = breakevenUnits * Math.round(input.unit_price);
  const marginPct = Number(((contribution / input.unit_price) * 100).toFixed(2));

  let expectedMonthlyProfit: number | null = null;
  let paybackMonths: number | null = null;
  let roiAnnualPct: number | null = null;

  if (typeof input.expected_monthly_units === 'number' && input.expected_monthly_units > 0) {
    expectedMonthlyProfit = Math.round(input.expected_monthly_units * contribution - fixedCosts);
    if (input.investment && input.investment > 0) {
      if (expectedMonthlyProfit > 0) {
        paybackMonths = Number((input.investment / expectedMonthlyProfit).toFixed(1));
      }
      roiAnnualPct = Number((((expectedMonthlyProfit * 12) / input.investment) * 100).toFixed(1));
    }
  }

  return {
    contribution_margin: contribution,
    margin_pct: marginPct,
    breakeven_units: breakevenUnits,
    breakeven_revenue: breakevenRevenue,
    expected_monthly_profit: expectedMonthlyProfit,
    payback_months: paybackMonths,
    roi_annual_pct: roiAnnualPct,
  };
}

export interface SafeLoanInput {
  profit_3m: number;
  existing_monthly_debt?: number;
  annual_rate: number;
  months: number;
  requested_principal?: number;
}

export interface SafeLoanResult {
  max_safe_monthly_payment: number;
  max_safe_principal: number;
  requested_monthly_payment: number | null;
  debt_to_profit_pct: number | null;
  verdict: 'safe' | 'caution' | 'risky';
}

export function calculateSafeLoan(input: SafeLoanInput): SafeLoanResult {
  const profit = Math.max(0, Math.round(input.profit_3m));
  const existing = Math.max(0, Math.round(input.existing_monthly_debt ?? 0));
  const maxSafePayment = Math.max(0, Math.round(profit * 0.35) - existing);

  const monthlyRate = input.annual_rate / 100 / 12;
  let maxSafePrincipal: number;
  if (monthlyRate === 0) {
    maxSafePrincipal = maxSafePayment * input.months;
  } else {
    const factor = Math.pow(1 + monthlyRate, input.months);
    maxSafePrincipal = Math.round((maxSafePayment * (factor - 1)) / (monthlyRate * factor));
  }

  let requestedPayment: number | null = null;
  let debtToProfitPct: number | null = null;
  let verdict: 'safe' | 'caution' | 'risky' = maxSafePayment > 0 ? 'safe' : 'risky';

  if (input.requested_principal && input.requested_principal > 0) {
    const calc = calculateLoan({
      principal: input.requested_principal,
      annual_rate: input.annual_rate,
      months: input.months,
      kind: 'annuity',
    });
    requestedPayment = calc.monthly_payment;
    const totalDebt = requestedPayment + existing;
    debtToProfitPct = profit > 0 ? Number(((totalDebt / profit) * 100).toFixed(1)) : 100;

    if (debtToProfitPct <= 35) verdict = 'safe';
    else if (debtToProfitPct <= 50) verdict = 'caution';
    else verdict = 'risky';
  }

  return {
    max_safe_monthly_payment: maxSafePayment,
    max_safe_principal: maxSafePrincipal,
    requested_monthly_payment: requestedPayment,
    debt_to_profit_pct: debtToProfitPct,
    verdict,
  };
}
