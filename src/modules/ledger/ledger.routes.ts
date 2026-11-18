import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth.js';
import { validateBody } from '../../middlewares/validate.js';
import { Errors } from '../../utils/errors.js';
import {
  generateDebtReminder,
  listDebtors,
  recordDebtorRepayment,
} from './debtors.service.js';
import {
  createObligation,
  createObligationSchema,
  deleteObligation,
  listObligations,
  patchObligationSchema,
  updateObligation,
} from './obligations.service.js';
import { loadUserTodayDashboard } from './ops.service.js';

const uuidSchema = z.string().uuid();

const repaidSchema = z.object({
  amount: z.number().int().positive().optional(),
  method: z.enum(['naqd', 'karta']).default('naqd'),
});

export const ledgerRouter = Router();
ledgerRouter.use(requireAuth);

ledgerRouter.get('/today', async (req, res, next) => {
  try {
    const dashboard = await loadUserTodayDashboard(req.user!.id, req.lang);
    res.json(dashboard);
  } catch (err) {
    next(err);
  }
});

export const debtorsRouter = Router();
debtorsRouter.use(requireAuth);

debtorsRouter.get('/', async (req, res, next) => {
  try {
    const result = await listDebtors(req.user!.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

debtorsRouter.post('/:id/repaid', validateBody(repaidSchema), async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('debtor_not_found', 'Debtor not found');
    }
    const result = await recordDebtorRepayment(req.user!.id, parsedId.data, req.body, req.lang);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

debtorsRouter.get('/:id/reminder', async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('debtor_not_found', 'Debtor not found');
    }
    const reminder = await generateDebtReminder(req.user!.id, parsedId.data, req.lang);
    res.json(reminder);
  } catch (err) {
    next(err);
  }
});

export const obligationsRouter = Router();
obligationsRouter.use(requireAuth);

obligationsRouter.get('/', async (req, res, next) => {
  try {
    const items = await listObligations(req.user!.id);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

obligationsRouter.post('/', validateBody(createObligationSchema), async (req, res, next) => {
  try {
    const created = await createObligation(req.user!.id, req.body);
    res.status(201).json({ obligation: created });
  } catch (err) {
    next(err);
  }
});

obligationsRouter.patch('/:id', validateBody(patchObligationSchema), async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('obligation_not_found', 'Obligation not found');
    }
    const updated = await updateObligation(req.user!.id, parsedId.data, req.body);
    res.json({ obligation: updated });
  } catch (err) {
    next(err);
  }
});

obligationsRouter.delete('/:id', async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('obligation_not_found', 'Obligation not found');
    }
    await deleteObligation(req.user!.id, parsedId.data);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
