import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import {
  generateBankReport,
  generateBusinessPlan,
  runWhatIfForecast,
} from './reports.service.js';

const whatIfSchema = z.object({
  scenario: z.enum(['buy', 'helper', 'loan']),
  amount: z.number().int().positive('Amount must be a positive integer'),
  day_offset: z.number().int().min(0).max(29).optional(),
  annual_rate: z.number().min(0).max(200).optional(),
  months: z.number().int().min(1).max(360).optional(),
});

const planSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  goal: z.string().trim().min(3, 'Goal description is required').max(500),
  investment: z.number().int().positive('Investment must be a positive integer'),
  target_monthly_sales: z.number().int().positive().optional(),
});

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.get('/bank', async (req, res, next) => {
  try {
    const months = req.query.months ? Number(req.query.months) : 3;
    const report = await generateBankReport(req.user!.id, months, req.lang);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

export const forecastRouter = Router();
forecastRouter.use(requireAuth);

forecastRouter.post('/whatif', validateBody(whatIfSchema), async (req, res, next) => {
  try {
    const result = await runWhatIfForecast({
      userId: req.user!.id,
      scenario: req.body.scenario,
      amount: req.body.amount,
      dayOffset: req.body.day_offset,
      annualRate: req.body.annual_rate,
      months: req.body.months,
      lang: req.lang,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export const advisorRouter = Router();
advisorRouter.use(requireAuth);

advisorRouter.post('/plan', validateBody(planSchema), async (req, res, next) => {
  try {
    const plan = await generateBusinessPlan({
      userId: req.user!.id,
      title: req.body.title,
      goal: req.body.goal,
      investment: req.body.investment,
      targetMonthlySales: req.body.target_monthly_sales,
      lang: req.lang,
    });
    res.status(201).json({ plan });
  } catch (err) {
    next(err);
  }
});
