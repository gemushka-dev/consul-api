import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth.js';
import { idempotencyMiddleware } from '../../middlewares/idempotency.js';
import { validateBody } from '../../middlewares/validate.js';
import { Errors } from '../../utils/errors.js';
import { parseOperationText } from '../parser/parser.engine.js';
import {
  createOperation,
  createOpSchema,
  listOperations,
  softDeleteOperation,
} from './ops.service.js';

const uuidSchema = z.string().uuid('Invalid operation ID');
const parseSchema = z.object({
  text: z.string().trim().min(1, 'Text is required').max(1000),
});

export const opsRouter = Router();

opsRouter.use(requireAuth);

opsRouter.post('/parse', validateBody(parseSchema), async (req, res, next) => {
  try {
    const parsed = await parseOperationText(req.body.text);
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

opsRouter.post('/', idempotencyMiddleware, validateBody(createOpSchema), async (req, res, next) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key')?.trim() || undefined;
    const result = await createOperation(req.user!.id, req.body, idempotencyKey, req.lang);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

opsRouter.get('/', async (req, res, next) => {
  try {
    const result = await listOperations(req.user!.id, {
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

opsRouter.delete('/:id', async (req, res, next) => {
  try {
    const parsedId = uuidSchema.safeParse(req.params.id);
    if (!parsedId.success) {
      throw Errors.notFound('op_not_found', 'Operation not found');
    }
    const result = await softDeleteOperation(req.user!.id, parsedId.data, req.lang);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
