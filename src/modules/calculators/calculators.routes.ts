import { and, desc, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../config/db.js';
import { calculationHistory } from '../../db/schema.js';
import { optionalAuth, requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { Errors } from '../../utils/errors.js';
import {
  calculateBreakeven,
  calculateLoan,
  calculateTax,
  UZ_TAX_RULES,
} from './calculators.engine.js';

const loanSchema = z.object({
  principal: z.number().int().positive('Principal must be a positive integer'),
  annual_rate: z.number().min(0).max(200),
  months: z.number().int().min(1).max(360),
  kind: z.enum(['annuity', 'differentiated']).default('annuity'),
});

const taxSchema = z.object({
  monthly_turnover: z.number().int().min(0),
  monthly_expenses: z.number().int().min(0).optional(),
  annual_turnover: z.number().int().min(0).optional(),
  status: z.enum(['yatt', 'oob', 'mchj', 'none']).optional(),
  regime: z.enum(['turnover', 'vat6', 'vat12']).optional(),
});

const breakevenSchema = z.object({
  fixed_costs: z.number().int().min(0),
  unit_price: z.number().int().positive(),
  unit_cost: z.number().int().min(0),
  investment: z.number().int().min(0).optional(),
  expected_monthly_units: z.number().int().positive().optional(),
});

export const calculatorRouter = Router();

calculatorRouter.get('/rules', (_req, res) => {
  res.json(UZ_TAX_RULES);
});

calculatorRouter.post(
  '/calculate',
  optionalAuth,
  validateBody(loanSchema),
  async (req, res, next) => {
    try {
      const result = calculateLoan(req.body);

      if (req.user) {
        const db = getDb();
        await db.insert(calculationHistory).values({
          userId: req.user.id,
          kind: 'loan',
          input: req.body,
          result: {
            ...result,
            schedule: result.schedule.slice(0, 3), // store summary in history
          },
        });
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

calculatorRouter.post('/tax', optionalAuth, validateBody(taxSchema), async (req, res, next) => {
  try {
    const result = calculateTax(req.body);

    if (req.user) {
      const db = getDb();
      await db.insert(calculationHistory).values({
        userId: req.user.id,
        kind: 'tax',
        input: req.body,
        result: result as unknown as Record<string, unknown>,
      });
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

calculatorRouter.post(
  '/breakeven',
  optionalAuth,
  validateBody(breakevenSchema),
  async (req, res, next) => {
    try {
      if (req.body.unit_price <= req.body.unit_cost) {
        throw Errors.badRequest(
          'invalid_margin',
          'unit_price must be greater than unit_cost',
          'unit_price',
        );
      }

      const result = calculateBreakeven(req.body);

      if (req.user) {
        const db = getDb();
        await db.insert(calculationHistory).values({
          userId: req.user.id,
          kind: 'breakeven',
          input: req.body,
          result: result as unknown as Record<string, unknown>,
        });
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

calculatorRouter.get('/history', requireAuth, async (req, res, next) => {
  try {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const db = getDb();
    const condition = kind
      ? and(eq(calculationHistory.userId, req.user!.id), eq(calculationHistory.kind, kind))
      : eq(calculationHistory.userId, req.user!.id);

    const rows = await db
      .select()
      .from(calculationHistory)
      .where(condition)
      .orderBy(desc(calculationHistory.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        input: r.input,
        result: r.result,
        created_at: r.createdAt.toISOString(),
      })),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});
