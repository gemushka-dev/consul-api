import { and, eq, isNull } from 'drizzle-orm';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { getDb } from '../../config/db.js';
import { memoryFacts, ops } from '../../db/schema.js';
import type { SupportedLang } from '../../types/express.d.js';
import { startOfTashkentMonth } from '../../utils/time.js';
import {
  calculateBreakeven,
  calculateLoan,
  calculateSafeLoan,
  calculateTax,
} from '../calculators/calculators.engine.js';
import { listDebtors } from '../ledger/debtors.service.js';
import { computeMonthSummary } from '../ledger/ledger.math.js';
import { loadUserTodayDashboard } from '../ledger/ops.service.js';

export interface PendingOpDraft {
  kind: 'sale' | 'buy' | 'exp' | 'sup' | 'nas' | 'repaid' | 'fix';
  amount: number;
  method: 'naqd' | 'karta' | 'none';
  label?: string;
  counterparty_name?: string;
  fiscal?: boolean;
}

export interface ToolExecutionContext {
  userId: string;
  lang: SupportedLang;
  chatId?: string;
  /** Maps masked token ("D1") -> real debtor name ("Akmal") for safe UI unmasking */
  piiMaskMap: Map<string, string>;
  /** Set when LLM calls draft_operation (LLM never writes to ops directly) */
  pendingOp: PendingOpDraft | null;
}

export interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  output: unknown;
}

export const CONSUL_TOOLS_SCHEMA: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_today',
      description: 'Get merchant Today dashboard: cash, naqd, karta, tax, obligations, reserve, free cash, profit_3m, owed_to_me, upcoming obligations.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_months',
      description: 'Get monthly sales, purchases, expenses, net profit, and margin for the last N months.',
      parameters: {
        type: 'object',
        properties: {
          months: { type: 'integer', minimum: 1, maximum: 12, default: 4 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_debtors',
      description: 'List active nasiya debtors with PII-masked identifiers (D1, D2, ...), debt amount in UZS, and overdue days.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_loan',
      description: 'Deterministically compute loan monthly payment, total interest, and schedule.',
      parameters: {
        type: 'object',
        properties: {
          principal: { type: 'integer' },
          annual_rate: { type: 'number' },
          months: { type: 'integer' },
          kind: { type: 'string', enum: ['annuity', 'differentiated'] },
        },
        required: ['principal', 'annual_rate', 'months'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_tax',
      description: 'Deterministically compare Uzbekistan 2026 tax regimes for a given monthly turnover.',
      parameters: {
        type: 'object',
        properties: {
          monthly_turnover: { type: 'integer' },
          monthly_expenses: { type: 'integer' },
          status: { type: 'string', enum: ['yatt', 'oob', 'mchj', 'none'] },
          regime: { type: 'string', enum: ['turnover', 'vat6', 'vat12'] },
        },
        required: ['monthly_turnover'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_breakeven',
      description: 'Deterministically compute breakeven units, revenue, payback months, and ROI.',
      parameters: {
        type: 'object',
        properties: {
          fixed_costs: { type: 'integer' },
          unit_price: { type: 'integer' },
          unit_cost: { type: 'integer' },
          investment: { type: 'integer' },
          expected_monthly_units: { type: 'integer' },
        },
        required: ['fixed_costs', 'unit_price', 'unit_cost'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'safe_loan',
      description: 'Evaluate whether a loan is safe based on the merchant 3-month average profit.',
      parameters: {
        type: 'object',
        properties: {
          annual_rate: { type: 'number', default: 24 },
          months: { type: 'integer', default: 24 },
          requested_principal: { type: 'integer' },
        },
        required: ['annual_rate', 'months'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_operation',
      description: 'Prepare a pending operation draft for user confirmation button. Does NOT save to database.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['sale', 'buy', 'exp', 'sup', 'nas', 'repaid', 'fix'] },
          amount: { type: 'integer' },
          method: { type: 'string', enum: ['naqd', 'karta', 'none'] },
          label: { type: 'string' },
          counterparty_name: { type: 'string' },
          fiscal: { type: 'boolean' },
        },
        required: ['kind', 'amount', 'method'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'simulate_cashflow',
      description: 'Simulate 30-day cashflow for a what-if scenario (buy, helper, or loan) and detect cash gaps.',
      parameters: {
        type: 'object',
        properties: {
          scenario: { type: 'string', enum: ['buy', 'helper', 'loan'] },
          amount: { type: 'integer' },
          day_offset: { type: 'integer', minimum: 0, maximum: 29, default: 1 },
        },
        required: ['scenario', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save an important long-term merchant fact into Consul Memory.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
  },
];

export async function executeConsulTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<unknown> {
  switch (name) {
    case 'get_today': {
      const today = await loadUserTodayDashboard(ctx.userId, ctx.lang);
      return {
        view: today.view,
        upcoming: today.upcoming,
        month: today.month,
      };
    }

    case 'get_months': {
      const count = Math.min(12, Math.max(1, Number(args.months) || 4));
      const db = getDb();
      const activeOps = await db
        .select()
        .from(ops)
        .where(and(eq(ops.userId, ctx.userId), isNull(ops.deletedAt)));

      const now = new Date();
      const months = [];
      for (let offset = -(count - 1); offset <= 0; offset++) {
        const start = startOfTashkentMonth(now, offset);
        const end = startOfTashkentMonth(now, offset + 1);
        months.push(computeMonthSummary(activeOps, start, end));
      }
      return { months };
    }

    case 'list_debtors': {
      const { items, total_owed } = await listDebtors(ctx.userId);
      // Mask PII (names & phones) as D1, D2, ... before sending to LLM
      const masked = items.map((d, idx) => {
        const code = `D${idx + 1}`;
        ctx.piiMaskMap.set(code, d.name);
        return {
          debtor_code: code,
          debt: d.debt,
          debt_days: d.debt_days,
        };
      });
      return {
        count: masked.length,
        total_owed,
        debtors: masked,
      };
    }

    case 'calculate_loan': {
      const res = calculateLoan({
        principal: Number(args.principal),
        annual_rate: Number(args.annual_rate),
        months: Number(args.months),
        kind: args.kind === 'differentiated' ? 'differentiated' : 'annuity',
      });
      return {
        kind: res.kind,
        principal: res.principal,
        annual_rate: res.annual_rate,
        months: res.months,
        monthly_payment: res.monthly_payment,
        total_payment: res.total_payment,
        total_interest: res.total_interest,
        overpayment_pct: res.overpayment_pct,
      };
    }

    case 'calculate_tax': {
      return calculateTax({
        monthly_turnover: Number(args.monthly_turnover),
        monthly_expenses: args.monthly_expenses ? Number(args.monthly_expenses) : undefined,
        status: args.status as 'yatt' | 'oob' | 'mchj' | 'none' | undefined,
        regime: args.regime as 'turnover' | 'vat6' | 'vat12' | undefined,
      });
    }

    case 'calculate_breakeven': {
      return calculateBreakeven({
        fixed_costs: Number(args.fixed_costs),
        unit_price: Number(args.unit_price),
        unit_cost: Number(args.unit_cost),
        investment: args.investment ? Number(args.investment) : undefined,
        expected_monthly_units: args.expected_monthly_units
          ? Number(args.expected_monthly_units)
          : undefined,
      });
    }

    case 'safe_loan': {
      const today = await loadUserTodayDashboard(ctx.userId, ctx.lang);
      return calculateSafeLoan({
        profit_3m: today.view.profit_3m,
        annual_rate: Number(args.annual_rate) || 24,
        months: Number(args.months) || 24,
        requested_principal: args.requested_principal
          ? Number(args.requested_principal)
          : undefined,
      });
    }

    case 'draft_operation': {
      const draft: PendingOpDraft = {
        kind: (args.kind as PendingOpDraft['kind']) ?? 'sale',
        amount: Math.round(Number(args.amount) || 0),
        method: (args.method as PendingOpDraft['method']) ?? 'naqd',
        ...(args.label ? { label: String(args.label) } : {}),
        ...(args.counterparty_name ? { counterparty_name: String(args.counterparty_name) } : {}),
        ...(typeof args.fiscal === 'boolean' ? { fiscal: args.fiscal } : {}),
      };
      ctx.pendingOp = draft;
      return { drafted: true, pending_op: draft };
    }

    case 'simulate_cashflow': {
      const today = await loadUserTodayDashboard(ctx.userId, ctx.lang);
      const amount = Math.max(0, Math.round(Number(args.amount) || 0));
      const dayOffset = Math.min(29, Math.max(0, Number(args.day_offset) || 1));
      const scenario = String(args.scenario ?? 'buy');

      let minCash = Number.POSITIVE_INFINITY;
      let firstGapDay: string | null = null;
      const simulated = today.forecast.map((d, idx) => {
        const extraOutflow = idx >= dayOffset ? amount : 0;
        const projected = d.projected_cash - extraOutflow;
        const gap = projected - today.view.reserve < 0;
        if (projected < minCash) minCash = projected;
        if (gap && !firstGapDay) firstGapDay = d.date;
        return { date: d.date, projected_cash: projected, cash_gap: gap };
      });

      return {
        scenario,
        amount,
        min_projected_cash: minCash,
        has_cash_gap: firstGapDay !== null,
        first_gap_date: firstGapDay,
        free_after_scenario: today.view.free - amount,
        days_count: simulated.length,
      };
    }

    case 'remember_fact': {
      const key = String(args.key ?? '').trim().slice(0, 100);
      const value = String(args.value ?? '').trim().slice(0, 500);
      if (!key || !value) return { saved: false };

      const db = getDb();
      await db.insert(memoryFacts).values({
        userId: ctx.userId,
        key,
        value,
        sourceChatId: ctx.chatId ?? null,
      });
      return { saved: true, key, value };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export function unmaskPiiText(text: string, maskMap: Map<string, string>): string {
  let result = text;
  for (const [code, realName] of maskMap.entries()) {
    const regex = new RegExp(`\\b${code}\\b`, 'g');
    result = result.replace(regex, realName);
  }
  return result;
}
